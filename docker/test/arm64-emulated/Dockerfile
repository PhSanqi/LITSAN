# amd64 harness for running the linux/arm64 image without host binfmt/QEMU setup.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends qemu-user-static uidmap curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && echo 'root:0:65536' > /etc/subuid && echo 'root:0:65536' > /etc/subgid
