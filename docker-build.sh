#!/usr/bin/env bash
set -e

VERSION="${1:-$(TZ=Asia/Taipei date +"%y%m.%-d.%-H%M")}"
IMAGE="cojad/openclaw"

echo "==> Building upstream OpenClaw image..."
docker build \
  -t openclaw:upstream \
  -f Dockerfile .

echo ""
echo "==> Building custom image: ${IMAGE}:${VERSION}"
docker build \
  --build-arg UPSTREAM_IMAGE=openclaw:upstream \
  --build-arg OPENCLAW_VERSION="${VERSION}" \
  -t "${IMAGE}:${VERSION}" \
  -f Dockerfile.cojad .

# Also tag as latest
docker tag "${IMAGE}:${VERSION}" "${IMAGE}:latest"

echo ""
echo "Built successfully:"
echo "   - ${IMAGE}:${VERSION}"
echo "   - ${IMAGE}:latest"
echo ""
echo "Environment variables set in image:"
echo "   OPENCLAW_BUNDLED_VERSION=${VERSION}"
