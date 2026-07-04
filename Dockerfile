FROM denoland/deno:2.9.1

WORKDIR /app
COPY discord-message-proxy.ts .
RUN deno cache discord-message-proxy.ts

EXPOSE 8000
ENTRYPOINT ["deno", "run", "--allow-net", "--allow-env", "discord-message-proxy.ts"]
