// Tiny HTTP app for the Seylo e2e Dockerfile build.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	host, _ := os.Hostname()
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "go-app %s on %s\n", os.Getenv("APP_VERSION"), host)
	})
	log.Printf("go-app listening on %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
