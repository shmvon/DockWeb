# Using DockWeb away from home Wi-Fi (Tailscale)

University and café Wi-Fi often use *client isolation*: devices on the same network cannot reach each other,
so the phone can't open `http://<mac-ip>:8511`. Tailscale builds a private, encrypted network between your own
devices that works across any network, as long as both have internet. DockWeb needs no changes.

## One-time setup

1. Create a free account at <https://tailscale.com> (sign in with Google/Apple/etc.).
2. **Mac:** install Tailscale (`brew install --cask tailscale` or the Mac App Store) and sign in.
3. **Phone:** install Tailscale (App Store / Google Play) and sign in with the **same account**.
4. Make sure the Tailscale toggle is on for both devices.

## Each time

1. Start DockWeb on the Mac (open `DockWeb.app`; it lives in the menu bar).
2. Find the Mac's Tailscale address (`100.x.y.z`), any of these ways:
   - the DockWeb menu-bar icon lists it among the addresses; or
   - the Tailscale menu-bar icon on the Mac, then copy the address; or
   - in Terminal: `tailscale ip -4` (looks like `100.x.y.z`).
3. On the phone, with Tailscale on, open `http://100.x.y.z:8511` and enter the PIN.
   With MagicDNS enabled you can use the device name instead, e.g. `http://my-macbook:8511`.
4. Optional: add it to the home screen (iPhone: Share → Add to Home Screen; Android Chrome: ⋮ → Add to Home screen). Use the Tailscale address for the home-screen icon so it works
   on any network (the old LAN-address icon will only work at home).

## Notes

- Traffic between the devices is encrypted by Tailscale, which also protects the PIN. Plain-LAN HTTP does not.
- The Mac must be awake and online. If it sleeps, DockWeb is unreachable until it wakes.
- Don't expose port 8511 to the public internet (port-forwarding, Tailscale Funnel, public tunnels): the server
  is protected only by a PIN and can shut down the Mac.
- To limit access further, use Tailscale ACLs so only your phone can reach the Mac.
- Alternatives: join the Mac to the phone's hotspot, then use the Mac's address on that network
  (iPhone Personal Hotspot: usually `172.20.10.x`) with no extra software. Bluetooth can't be used by a web app.
