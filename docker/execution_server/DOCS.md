# Execution Server module

Eric's Execution Server runs in Rust, and it connects to a set Docker proxy socket at `http://docker-proxy:2375` to manage "jae-box" execution containers.

## Use(s) in Jae

Jae uses Execution Server for tool-calling and debugging purposes (orchestrated by the programming, done by the AI.)

## References

- 📂 **src**
    - 📝 *[tools/run_command.ts](../../src/tools/run_command.ts)*: Tool call use
    - 📝 *[utils/tools/execution_server/api.ts](../../src/utils/tools/execution_server/api.ts)*: API implementation

## Required Configuration K/Vs on Jae

[`.env`](../../.env)
```ini
EXECUTION_SERVER=127.0.0.1:6200   # or another IP address

EXECUTION_SERVER_TOKEN=""   # anything you set, can be blank or deleted and tokenized authentication won't be considered
```

## Required Configuration K/Vs in Module

[`docker/execution_server/.env`](./.env)
```ini
EXECUTION_SERVER_TOKEN=

# THIS EXECUTION SERVER WILL BE EXPOSED TO THE HOST VIA DOCKER COMPOSE,
# !!!  EDIT THE FORWARDED PORTS INSIDE DOCKER-COMPOSE.YML INSTEAD  !!!
EXECUTION_SERVER_PORT=6200
EXECUTION_SERVER_HOST=0.0.0.0   # should always be 0.0.0.0
```

## !! Disclaimer for Port Forwarding

Port forwarding through Docker's internal `jae-net` network is managed per-container through the [`docker/docker-compose.yml`](../docker-compose.yml) file.

**If you change the port in the .env file and the server is then unreachable on the host, please refer to below.**

```yml
...
    ports: # EDIT PORT FORWARDING HERE! hostPort:containerPort/tcp
      - "6200:6200/tcp"
...
```

---

*this file was a 100% human written by the human creator 🤗* - jae, september 2026