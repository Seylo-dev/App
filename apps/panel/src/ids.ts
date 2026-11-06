// Panel-issued ids: 16 characters of [0-9a-z] (about 82 bits). They end up
// in Docker names, network names and paths on nodes, which only accept
// lowercase letters, digits, "-" and "_" (go/internal/datadir).

import { customAlphabet } from "nanoid";

export const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);
