FROM oven/bun:1.3 AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun build src/index.ts --target bun --compile --outfile angel

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/angel /usr/local/bin/angel

CMD ["angel"]
