// Package compose loads compose files with compose-go (the reference
// implementation, pinned) for AgentService.ParseCompose: interpolation
// from the stack's .env, extends within the file, defaults and
// normalization, returned as compose-go's normalized project JSON plus
// one warning line for every feature the agent does not run as written (host
// networking, privileged mode, bind mounts, published ports that should
// become domains or IP:port access, build sections, ...).
//
// Parsing never reads the node: include, extends from other files,
// env_file and label_file are refused or left unread, and only the
// variables sent with the request are used for interpolation.
//
// Interfaces used by other packages:
//
//   - Parse: the ParseCompose RPC handler calls it.
package compose
