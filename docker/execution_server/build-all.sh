#!/bin/bash

CURRENT_DIR=$PWD; # should be the jae/docker/execution_server directory

# build rust programs
rustup target add x86_64-unknown-linux-musl
cargo build --target x86_64-unknown-linux-musl --release
cd $CURRENT_DIR/inside_agent && cargo build --target x86_64-unknown-linux-musl --release

cd $CURRENT_DIR && docker build -t jae-exec-server .
cd $CURRENT_DIR/inside_agent && docker build -t jae-exec-worker .