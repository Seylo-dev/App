# Seylo 0.2.22

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-22

## Fixed

- **A project's service count showed on top of its row's buttons.** In the sidebar, a project row's **+** and **...** buttons show on hover, from the keyboard or while their menu is open, and the service count hides then. After a menu or the New service dialog was closed with the mouse, focus went back to the button, which kept the buttons showing while the count came back, so the number sat on the **...**. The buttons now show on exactly the cases the count hides on.

## After the update

- Nothing to run by hand: no migration, panel only.
