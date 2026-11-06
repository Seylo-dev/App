# Two-stage build of the e2e Go app (public base images only).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -o /goapp .

FROM alpine:3.21
COPY --from=build /goapp /goapp
ENV APP_VERSION=dockerfile
EXPOSE 8080
CMD ["/goapp"]
