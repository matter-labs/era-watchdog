FROM rust:1.67 as builder

WORKDIR /app

COPY . .

RUN cargo build --release

FROM debian:buster-slim

COPY --from=builder /app/target/release/caller /usr/bin/watchdog

EXPOSE 8080

ENTRYPOINT "/usr/bin/watchdog"
