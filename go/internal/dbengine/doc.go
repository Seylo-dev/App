// Package dbengine holds the facts about database engines that the
// packages handling SERVICE_KIND_DATABASE (backup, dbtools, portgate) must
// agree on: the ports inside the container, which engines speak the Redis
// protocol, which exposed ports the portgate wraps in TLS, and the
// capabilities an agent advertises once it handles the engines added
// after the first five and exposure with the database's own user.
//
// It has no state and imports nothing of the agent; any package may use it.
package dbengine
