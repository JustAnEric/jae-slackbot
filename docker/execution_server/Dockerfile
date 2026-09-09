FROM alpine:latest

COPY --chmod=755 target/x86_64-unknown-linux-musl/release/execution_server_jae /usr/local/bin/_jae_exec_server

RUN adduser -D -u 1000 runner
USER runner
WORKDIR /home/runner

ENTRYPOINT ["/usr/local/bin/_jae_exec_server"]