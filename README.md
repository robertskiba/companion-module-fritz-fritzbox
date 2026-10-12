# companion-module-fritz-fritzbox

A [Bitfocus Companion](https://bitfocus.io/companion) module for the FRITZ!Box: router status as variables and feedbacks, and control of the smart home devices connected to the box.

See [companion/HELP.md](companion/HELP.md) for what it offers and how to set up the box.

## Interfaces used

- **TR-064** (SOAP with HTTP digest authentication) for the router status
- **UPnP IGD** (no login, home network only) for IPv6 details and as a throughput fallback
- Over the internet (MyFRITZ! or another dynamic DNS name) TR-064 is used below `/tr064` on the HTTPS port of the remote access
- **Smart Home REST API** (`/api/v0/smarthome`, FRITZ!OS 8.20 or later), authenticated with a session ID from `login_sid.lua`

The specifications are published by FRITZ! at https://fritz.com/pages/schnittstellen.

## Development

```bash
yarn install
yarn build
yarn test
```

The tests run the built module against a simulated FRITZ!Box (`tests/fakebox.mjs`).

To check against a real box without Companion:

```bash
yarn live-check 192.168.178.1 companion
yarn live-check https://xxxxxxxxxxxxxxxx.myfritz.net:43167 companion
```

The script asks for the password, only reads, and logs out at the end.

## License

MIT
