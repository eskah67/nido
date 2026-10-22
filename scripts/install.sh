#!/bin/sh
# Installe ou met à jour Nido dans Home Assistant.
# À lancer depuis l'app « Terminal & SSH » de Home Assistant :
#   curl -fsSL https://raw.githubusercontent.com/__OWNER__/nido/main/scripts/install.sh | sh
#
# Options (variables d'environnement) :
#   NIDO_DEST    dossier d'installation (par défaut /config/www/nido)
#   NIDO_BRANCH  branche ou tag à installer (par défaut main)
set -eu

REPO="${NIDO_REPO:-__OWNER__/nido}"
BRANCH="${NIDO_BRANCH:-main}"
DEST="${NIDO_DEST:-/config/www/nido}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Téléchargement de Nido ($REPO@$BRANCH)…"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "https://github.com/$REPO/archive/$BRANCH.tar.gz" -o "$TMP/nido.tar.gz"
else
  wget -qO "$TMP/nido.tar.gz" "https://github.com/$REPO/archive/$BRANCH.tar.gz"
fi
tar -xzf "$TMP/nido.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 3 -type d -path '*/www/nido' | head -n 1)"
[ -n "$SRC" ] || { echo "Archive inattendue : dossier www/nido introuvable." >&2; exit 1; }

# La configuration personnelle (config.js) est conservée lors d'une mise à jour.
if [ -f "$DEST/config.js" ]; then
  cp "$DEST/config.js" "$TMP/config.keep"
fi
NEW_WWW=0
[ -d "$(dirname "$DEST")" ] || NEW_WWW=1
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
if [ -f "$TMP/config.keep" ]; then
  cp "$TMP/config.keep" "$DEST/config.js"
fi

echo "Nido est installé dans $DEST."
echo "Ouvre https://<adresse-de-ton-home-assistant>/local/nido/index.html"
if [ "$NEW_WWW" = 1 ]; then
  echo "Le dossier www vient d'être créé : redémarre Home Assistant une fois pour qu'il soit servi."
fi
