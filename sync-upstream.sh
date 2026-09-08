#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== mcp-memory-graph Upstream Senkronizasyonu Başlatılıyor ==="
echo "Dizin: $DIR"

# 1. Upstream ve Origin değişikliklerini çek
echo "1. Upstream uzak deposu kontrol ediliyor..."
git fetch upstream
git fetch origin

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Aktif Dal: $CURRENT_BRANCH"

# 2. Upstream main dalını mevcut dala birleştir
echo "2. Upstream/main güncellemeleri birleştiriliyor..."
git merge upstream/main --no-edit -m "merge: sync upstream/main into $CURRENT_BRANCH" || {
    echo "UYARI: Otomatik birleştirme çakışması oluştu. Lütfen çakışmaları çözün."
    exit 1
}

# 3. Bağımlılıkları kontrol et ve derle
echo "3. Sunucu ve Web Dashboard derlemesi yapılıyor (npm run build:all)..."
npm run build
npm run build:web
systemctl --user restart mcp-memory-web.service 2>/dev/null || true

echo "4. Değişiklikler forka pushlanıyor..."
git push origin "$CURRENT_BRANCH" || true

echo "=== SENKRONİZASYON BAŞARIYLA TAMAMLANDI ==="
echo "Son Commit: $(git log -1 --oneline)"
