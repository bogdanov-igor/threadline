# Local mode

This page is for running Threadline on your own computer, without Kubernetes and without PostgreSQL. There is one user, sign-in is off, and the address is `127.0.0.1` only. You connect your own Grafana or Loki right in the interface.

## What you need in advance

- Node.js 24 and pnpm.
- A copy of the Threadline repository.
- The address of your Grafana and a service account token with the Viewer role. Or the Loki address if you query it directly.

## Step 1. Start it

In the repository root:

```bash
pnpm install
pnpm local
```

The first start builds the interface, which takes about a minute. Then Threadline opens the browser at `http://127.0.0.1:8080/` by itself. If port 8080 is busy, the next free one is used. The address is printed in the terminal.

To stop, press Ctrl+C in the terminal. Running `pnpm local` again with the same data folder does not start a second copy, it opens the running one.

After updating the repository with `git pull`, build the interface again: `pnpm install && pnpm build`, then `pnpm local`. The command itself builds the interface only when there is none yet.

| Option | What it does |
|---|---|
| `--port 8085` | your own port; if it is busy, Threadline does not start and says so |
| `--data ~/threadline-work` | your own data folder, the `THREADLINE_DATA` variable does the same |
| `--no-open` | do not open the browser |

Options go after two hyphens: `pnpm local -- --port 8085 --no-open`.

## Step 2. Look at the demo

The first start opens the Demo Pay demo project. Its records are made up, Threadline does not go to the network for them. At the top of the start page there is a «Connect a storage» call to action, with search examples below it: a click on an example searches right away. The cross hides the call to action, and this browser does not show it again.

## Step 3. Connect a storage

Press «Connect a storage». The same page opens from the «Storages» item in the profile menu and from the «Connect a storage» button in the «Status» section of the «Service settings» page; address `/admin/storages`.

1. Choose what you connect: Grafana or Loki directly.
2. For Grafana, give the address, for example `https://grafana.example`, the service account token and the Loki data source: by name, uid or id.
3. For Loki, give the address, for example `http://localhost:3100`, and the sign-in: none, a Bearer token, or a name and password. The tenant is needed only for multi-tenant Loki.
4. «Environment label» is the label that tells your services apart, usually `namespace`, `service_name` or `job`. Each project environment on this storage is an equality condition on it.
5. Press «Check». Threadline queries the storage with the same request as the «Check» button in the storage row on the «Service settings» page.
6. Press «Save». The storage works right away, no restart needed.

## Step 4. Create a project

After saving, press «Create project». Give it a name and an environment, pick the storage you just connected, and set the environment condition to equality on the environment label, for example `namespace = shop`. From here search works as on a server.

## Where things are

Everything lives in the data folder, `~/.threadline` by default. The folder is created readable only by you.

| File | What is in it |
|---|---|
| `threadline.yaml` | settings: written on the first start, the demo project and sign-in off |
| `storages.json` | connected storages: addresses and **tokens**, permissions `0600` |
| `db/` | the embedded PGlite database: projects, catalog, settings |
| `catalog/`, `logos/` | the demo project's starting catalog and logos |

The token and password are kept only in `storages.json`. They never reach the browser, the page shows only «token set». They are not written to the log either.

To change a token, delete the storage on the page and connect it again with the same name. The environments on it work again.

Your own root certificate for Grafana or Loki is set with a Node variable: `NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem pnpm local`. The proxy comes from `HTTPS_PROXY` and `NO_PROXY`.

## How to start over

Stop Threadline and delete the data folder:

```bash
rm -rf ~/.threadline
```

The next `pnpm local` creates it again, with the demo project and no storages.

## What this mode does not have

- Sign-in and roles: anyone who opens the address is an administrator. That is why the address is `127.0.0.1` only, Threadline does not accept another one in this mode.
- The `.env` file and the server's `THREADLINE_*` variables: the settings live entirely in the data folder.
- Network use by several people. For that you need a server with sign-in, see the «Installation» page.
