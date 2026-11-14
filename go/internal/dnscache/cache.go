package dnscache

import (
	"container/list"
	"sync"
	"time"
)

// Default bounds of the cache.
const (
	defaultMaxEntries = 10_000
	defaultMaxBytes   = 8 << 20
	// entryOverhead is about what an entry costs besides its key and
	// message (list element, map slot, times).
	entryOverhead = 96
)

// entry is one cached upstream answer, packed without OPT, id 0.
type entry struct {
	key     key
	msg     []byte
	stored  time.Time
	expires time.Time
}

func (e *entry) size() int { return e.key.size() + len(e.msg) + entryOverhead }

// cache is an LRU of answers bounded by entries and bytes. An expired
// entry stays until staleFor after it expired (serve-stale) or until the
// bounds push it out.
type cache struct {
	maxEntries, maxBytes int

	mu    sync.Mutex
	ll    *list.List // front = most recently used
	items map[key]*list.Element
	bytes int
}

func newCache(maxEntries, maxBytes int) *cache {
	if maxEntries <= 0 {
		maxEntries = defaultMaxEntries
	}
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	return &cache{maxEntries: maxEntries, maxBytes: maxBytes, ll: list.New(), items: map[key]*list.Element{}}
}

// get returns k's entry while it is fresh (fresh true) or expired for at
// most staleFor (fresh false). Entries past that are dropped.
func (c *cache) get(k key, now time.Time) (e entry, fresh, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, found := c.items[k]
	if !found {
		return entry{}, false, false
	}
	ent := el.Value.(*entry)
	if now.Sub(ent.expires) > staleFor {
		c.remove(el)
		return entry{}, false, false
	}
	c.ll.MoveToFront(el)
	return *ent, now.Before(ent.expires), true
}

// put stores an answer, replacing k's, and evicts the least recently used
// entries past the bounds. An answer larger than the whole budget is not
// kept.
func (c *cache) put(e entry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, found := c.items[e.key]; found {
		c.remove(el)
	}
	if e.size() > c.maxBytes {
		return
	}
	c.items[e.key] = c.ll.PushFront(&e)
	c.bytes += e.size()
	for c.ll.Len() > c.maxEntries || c.bytes > c.maxBytes {
		c.remove(c.ll.Back())
	}
}

func (c *cache) remove(el *list.Element) {
	ent := c.ll.Remove(el).(*entry)
	delete(c.items, ent.key)
	c.bytes -= ent.size()
}

// len is the number of entries held.
func (c *cache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

// usage is the bytes the entries are counted at.
func (c *cache) usage() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytes
}
