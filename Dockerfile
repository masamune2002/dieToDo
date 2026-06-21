# ---- build stage ----
FROM rust:1-slim-bookworm AS builder
WORKDIR /app

# Build dependencies first (cached) using a stub main, then the real sources.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

# ---- runtime stage ----
FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/dice-todo-server /app/dice-todo-server
COPY static ./static

ENV PORT=3000
EXPOSE 3000
CMD ["/app/dice-todo-server"]
