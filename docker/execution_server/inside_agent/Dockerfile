FROM alpine:latest

COPY --chmod=755 target/x86_64-unknown-linux-musl/release/execution_server_jae_inside_agent /usr/local/bin/_jae_inside_agent

# install Python
RUN apk add python3 curl nodejs rustup cargo

RUN adduser -D -u 1000 runner
USER runner
WORKDIR /home/runner

ENTRYPOINT ["/usr/local/bin/_jae_inside_agent"]
CMD ["python3", "-c", "print('hello from jae sandbox!')"]