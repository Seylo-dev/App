// Package geoiptest writes small MaxMind DB files for tests: an IPv6 tree
// with record size 24 (IPv4 networks under ::/96, where readers look IPv4
// addresses up) whose networks carry {"country": {"iso_code": <code>}}, the
// shape of DB-IP's IP to Country Lite and MaxMind's GeoLite2 Country.
package geoiptest

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"net/netip"
	"sort"
	"time"
)

// Network is one network of the database and its country code. Networks
// must not overlap.
type Network struct {
	Prefix  netip.Prefix
	Country string
}

// N is shorthand for a Network: N("1.2.3.0/24", "DE").
func N(prefix, country string) Network {
	return Network{Prefix: netip.MustParsePrefix(prefix), Country: country}
}

type node struct {
	child [2]*node
	data  [2]int // index into the data entries + 1; 0 is none
	index int
}

// Write returns the bytes of a database of type dbType (for example
// "DBIP-Country-Lite") built at built.
func Write(dbType string, built time.Time, networks ...Network) []byte {
	root := &node{}
	var countries []string
	dataIndex := map[string]int{}
	for _, n := range networks {
		if _, ok := dataIndex[n.Country]; !ok {
			countries = append(countries, n.Country)
			dataIndex[n.Country] = len(countries)
		}
		addr, bits := n.Prefix.Masked().Addr(), n.Prefix.Bits()
		if addr.Is4() {
			addr, bits = netip.AddrFrom16(addr.As16()), bits+96
			// AddrFrom16 of an IPv4 address is ::ffff:a.b.c.d; readers
			// look IPv4 up under ::a.b.c.d.
			b := addr.As16()
			b[10], b[11] = 0, 0
			addr = netip.AddrFrom16(b)
		}
		if bits == 0 {
			panic("geoiptest: a /0 network has no record")
		}
		raw := addr.As16()
		cur := root
		for i := 0; i < bits; i++ {
			bit := (raw[i/8] >> (7 - uint(i%8))) & 1
			if i == bits-1 {
				cur.data[bit] = dataIndex[n.Country]
				cur.child[bit] = nil
				break
			}
			if cur.child[bit] == nil {
				cur.child[bit] = &node{}
			}
			cur = cur.child[bit]
		}
	}

	// Number the nodes breadth first, the root first.
	var nodes []*node
	queue := []*node{root}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		n.index = len(nodes)
		nodes = append(nodes, n)
		for _, c := range n.child {
			if c != nil {
				queue = append(queue, c)
			}
		}
	}

	var data bytes.Buffer
	offsets := make([]int, len(countries)+1)
	for i, c := range countries {
		offsets[i+1] = data.Len()
		writeMap(&data, func(w *bytes.Buffer) int {
			writeString(w, "country")
			writeMap(w, func(w *bytes.Buffer) int {
				writeString(w, "iso_code")
				writeString(w, c)
				return 1
			})
			return 1
		})
	}

	count := len(nodes)
	record := func(n *node, side int) uint32 {
		switch {
		case n.child[side] != nil:
			return uint32(n.child[side].index)
		case n.data[side] != 0:
			return uint32(count + 16 + offsets[n.data[side]])
		default:
			return uint32(count)
		}
	}
	var out bytes.Buffer
	for _, n := range nodes {
		for side := 0; side < 2; side++ {
			v := record(n, side)
			out.Write([]byte{byte(v >> 16), byte(v >> 8), byte(v)})
		}
	}
	out.Write(make([]byte, 16))
	out.Write(data.Bytes())
	out.WriteString("\xAB\xCD\xEFMaxMind.com")
	meta := map[string]func(w *bytes.Buffer){
		"binary_format_major_version": func(w *bytes.Buffer) { writeUint(w, 5, 2) },
		"binary_format_minor_version": func(w *bytes.Buffer) { writeUint(w, 5, 0) },
		"build_epoch":                 func(w *bytes.Buffer) { writeUint(w, 9, uint64(built.Unix())) },
		"database_type":               func(w *bytes.Buffer) { writeString(w, dbType) },
		"description": func(w *bytes.Buffer) {
			writeMap(w, func(w *bytes.Buffer) int { writeString(w, "en"); writeString(w, "test database"); return 1 })
		},
		"ip_version":  func(w *bytes.Buffer) { writeUint(w, 5, 6) },
		"languages":   func(w *bytes.Buffer) { writeControl(w, 11, 1); writeString(w, "en") },
		"node_count":  func(w *bytes.Buffer) { writeUint(w, 6, uint64(count)) },
		"record_size": func(w *bytes.Buffer) { writeUint(w, 5, 24) },
	}
	keys := make([]string, 0, len(meta))
	for k := range meta {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	writeMap(&out, func(w *bytes.Buffer) int {
		for _, k := range keys {
			writeString(w, k)
			meta[k](w)
		}
		return len(keys)
	})
	return out.Bytes()
}

// writeControl writes a control byte for type typ and size (< 29).
func writeControl(w *bytes.Buffer, typ, size int) {
	if size >= 29 {
		panic(fmt.Sprintf("geoiptest: size %d too large", size))
	}
	if typ <= 7 {
		w.WriteByte(byte(typ<<5 | size))
		return
	}
	w.WriteByte(byte(size))
	w.WriteByte(byte(typ - 7))
}

func writeString(w *bytes.Buffer, s string) {
	writeControl(w, 2, len(s))
	w.WriteString(s)
}

// writeUint writes an unsigned integer of type typ (5 uint16, 6 uint32,
// 9 uint64) in as few bytes as it takes.
func writeUint(w *bytes.Buffer, typ int, v uint64) {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	i := 0
	for i < 8 && b[i] == 0 {
		i++
	}
	writeControl(w, typ, 8-i)
	w.Write(b[i:])
}

// writeMap writes a map whose pairs fill writes (it returns their count).
func writeMap(w *bytes.Buffer, fill func(w *bytes.Buffer) int) {
	var body bytes.Buffer
	n := fill(&body)
	writeControl(w, 7, n)
	w.Write(body.Bytes())
}
