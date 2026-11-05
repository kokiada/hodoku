#!/usr/bin/env bash
#
# Docker インストールスクリプト（Ubuntu 想定 / あなた自身が実行する前提）
#
# 2つの方式を選べる:
#   rootless  … あなたのユーザー権限で動く Docker（推奨・安全）。root作業は uidmap 導入のみ。
#   engine    … システム全体の Docker Engine（公式スクリプト）。全工程で root が必要。
#
# 使い方:
#   bash scripts/install-docker.sh            # 既定: rootless
#   bash scripts/install-docker.sh rootless
#   bash scripts/install-docker.sh engine
#
# root が必要な箇所は内部で sudo を呼ぶので、実行時にパスワードを求められます。
#
set -euo pipefail

MODE="${1:-rootless}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  OK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1; }

# --- 事前チェック -----------------------------------------------------------
preflight() {
  log "環境を確認します"
  [ "$(uname -s)" = "Linux" ] || die "Linux 専用です"
  if require_cmd apt-get; then
    ok "apt-get あり（Debian/Ubuntu 系）"
  else
    warn "apt-get が見つかりません。uidmap の自動導入はスキップされます"
  fi
  printf '  arch: %s\n' "$(uname -m)"
  if require_cmd docker; then
    warn "既に docker が入っています: $(docker --version 2>/dev/null || true)"
  fi
}

# --- rootless 方式 ----------------------------------------------------------
install_rootless() {
  log "rootless Docker をインストールします（あなたのユーザー権限で動作）"

  # 1) 前提パッケージ（ここだけ root 必要）
  if ! require_cmd newuidmap || ! require_cmd newgidmap; then
    if require_cmd apt-get; then
      log "uidmap / dbus-user-session / uidmap を導入します（sudo でパスワードを求められます）"
      sudo apt-get update
      sudo apt-get install -y uidmap dbus-user-session fuse-overlayfs
    else
      die "newuidmap/newgidmap が無く、apt-get も無いため自動導入できません。uidmap パッケージを手動で入れてください"
    fi
  else
    ok "newuidmap/newgidmap は導入済み"
  fi

  # 2) /etc/subuid, /etc/subgid にユーザーエントリがあるか
  local u; u="$(id -un)"
  if ! grep -q "^${u}:" /etc/subuid 2>/dev/null; then
    warn "/etc/subuid に ${u} のエントリがありません。追加します（sudo）"
    echo "${u}:100000:65536" | sudo tee -a /etc/subuid >/dev/null
  fi
  if ! grep -q "^${u}:" /etc/subgid 2>/dev/null; then
    warn "/etc/subgid に ${u} のエントリがありません。追加します（sudo）"
    echo "${u}:100000:65536" | sudo tee -a /etc/subgid >/dev/null
  fi
  ok "subuid/subgid 設定を確認"

  # 3) Docker 本体（rootless 用の静的バイナリ）を公式インストーラで取得
  #    get.docker.com/rootless は ~/bin に展開し、root を使いません。
  log "rootless 用 Docker バイナリを取得します（curl | sh, root不要）"
  require_cmd curl || die "curl が必要です（sudo apt-get install -y curl）"
  curl -fsSL https://get.docker.com/rootless | sh

  # 4) PATH / DOCKER_HOST を通す
  local binpath="${HOME}/bin"
  local sockpath="unix://${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
  local rc="${HOME}/.bashrc"
  if ! grep -q 'rootless docker (install-docker.sh)' "$rc" 2>/dev/null; then
    {
      echo ''
      echo '# rootless docker (install-docker.sh)'
      echo "export PATH=\"${binpath}:\$PATH\""
      echo "export DOCKER_HOST=\"${sockpath}\""
    } >> "$rc"
    ok ".bashrc に PATH と DOCKER_HOST を追記しました"
  else
    ok ".bashrc は設定済み"
  fi

  # 5) systemd user サービスで常駐起動（ログアウト後も動くよう linger 有効化）
  export PATH="${binpath}:$PATH"
  export DOCKER_HOST="${sockpath}"
  if require_cmd systemctl; then
    log "dockerd を systemd user サービスとして起動します"
    systemctl --user daemon-reload || true
    "${binpath}/dockerd-rootless-setuptool.sh" install || warn "setuptool install がスキップ/失敗（既に設定済みの可能性）"
    systemctl --user enable --now docker || warn "docker.service の有効化に失敗（手動確認してください）"
    # ログアウトしても止まらないように（sudo で linger 有効化）
    sudo loginctl enable-linger "$u" 2>/dev/null && ok "linger 有効化（ログアウト後も稼働）" || warn "linger 設定をスキップ"
  else
    warn "systemctl が無いため、必要時に ${binpath}/dockerd-rootless.sh & で手動起動してください"
  fi

  log "確認します"
  "${binpath}/docker" version || warn "docker version が失敗。新しいシェルを開いて再確認してください"

  cat <<EOF

--------------------------------------------------------------------
rootless Docker のセットアップが完了しました。

このシェルには反映されていない場合があります。新しいシェルを開くか、
次を実行してください:

  source ~/.bashrc

その後の確認:

  docker run --rm hello-world
  docker info | grep -i rootless

このプロジェクトのイメージをビルドするには:

  cd $(cd "$(dirname "$0")/.." && pwd)
  docker build -t hodoku-app:local .
--------------------------------------------------------------------
EOF
}

# --- engine 方式（システム全体） -------------------------------------------
install_engine() {
  log "システム全体の Docker Engine をインストールします（公式スクリプト・全工程で root）"
  require_cmd curl || die "curl が必要です（sudo apt-get install -y curl）"

  log "公式インストールスクリプトを取得して実行します（sudo）"
  # get.docker.com を一度ローカルに落としてから sudo 実行（パイプ直 sudo を避ける）
  local tmp; tmp="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$tmp"
  sudo sh "$tmp"
  rm -f "$tmp"

  # sudo 無しで docker を使えるよう docker グループに追加
  local u; u="$(id -un)"
  log "${u} を docker グループに追加します（反映にはログインし直しが必要）"
  sudo usermod -aG docker "$u" || warn "docker グループ追加に失敗"

  log "確認します"
  sudo docker version || warn "docker version が失敗"

  cat <<EOF

--------------------------------------------------------------------
Docker Engine のインストールが完了しました。

sudo 無しで docker を使うには、一度ログアウト/ログインするか、
次を実行して新しいグループを反映してください:

  newgrp docker

その後の確認:

  docker run --rm hello-world

このプロジェクトのイメージをビルドするには:

  cd $(cd "$(dirname "$0")/.." && pwd)
  docker build -t hodoku-app:local .
--------------------------------------------------------------------
EOF
}

main() {
  preflight
  case "$MODE" in
    rootless) install_rootless ;;
    engine)   install_engine ;;
    *) die "不明なモード: '$MODE'（rootless または engine を指定）" ;;
  esac
}

main "$@"
