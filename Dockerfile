FROM rust:1.67 as builder

WORKDIR /app

COPY . .

RUN cargo build --release

EXPOSE 8080

CMD cargo run --release

FROM debian:buster-slim

COPY --from=builder /app/target/release/caller /usr/bin/watchdog

ENTRYPOINT "/usr/bin/watchdog"
