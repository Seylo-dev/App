# Seylo 0.2.22

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-22

## Fixed

- **A busy exposed database turned new connections away without a word.** The agent's listener for an exposed port took at most 1024 connections, 256 from one address, and closed any client over that at once, with nothing in any log. Connection pools reach a database in numbers (one owner's MySQL carried about 1000 game-server connections, 250 from one node's address), so new connections were cut and clients reported errors such as "incomplete response". A database's listeners, its exposed port and its timed exposes, now take up to 16384 connections, 8192 from one address: the database's own `max_connections` is the limit that counts. App ports keep 1024 and 256. A full listener now says so in the agent's log (`portgate listener is full`, with the cap it hit), once a minute. Needs the node's agent 0.2.22; the agent's update restarts its listeners, so exposed connections drop once and reconnect.
- **A project's service count showed on top of its row's buttons.** In the sidebar, a project row's **+** and **...** buttons show on hover, from the keyboard or while their menu is open, and the service count hides then. After a menu or the New service dialog was closed with the mouse, focus went back to the button, which kept the buttons showing while the count came back, so the number sat on the **...**. The buttons now show on exactly the cases the count hides on.

## After the update

- Nothing to run by hand: no migration. The sidebar fix needs only the panel; the database connection caps need each node's agent 0.2.22.
- Updating a node's agent restarts the listeners of its exposed ports: every client connected through them drops at once and reconnects. Update a node with busy exposed databases at a quiet time.
