
# Electric Gatekeeper Auth Example

This example demonstrates a number of ways of implementing the [Gatekeeper auth pattern](https://electric-sql.com/docs/guides/auth#gatekeeper) for securing access to the [Electric sync service](https://electric-sql.com/product/sync).

It includes:

- an [`./api`](./api) service for generating auth tokens
- three options for validating those auth tokens when proxying requests to Electric:
    - [`./api`](./api) the API itself
    - [`./caddy`](./caddy) a Caddy web server as a reverse proxy
    - [`./edge`](./edge) an edge function that you can run in front of a CDN


## How it works

There are two steps to the gatekeeper pattern:

1. first a client posts authentication credentials to a gatekeeper endpoint to generate an auth token
2. the client then makes requests to Electric via an authorising proxy that validates the auth token against the shape request

The auth token can be *shape-scoped* (i.e.: can sign a specific shape definition). This allows the proxy to authorise a shape request by comparing the shape signed into the token with the [shape defined in the request parameters](https://electric-sql.com/docs/quickstart#http-api). This allows you to:

- keep your main authorisation logic in your API (in the gatekeeper endpoint) where it's natural to do things like query the database and call external authorisation services; and to
- run your authorisation logic *once* when generating a token, rather than on the "hot path" of every shape request in your authorising proxy

### Implementation

The core of this example is an [Elixir/Phoenix](https://www.phoenixframework.org) web application in [`./api`](./api). This exposes (in [`api_web/router.ex`](./api/lib/api_web/router.ex)):

1. a gatekeeper endpoint at `POST /gatekeeper/:table`
2. a proxy endpoint at `GET /proxy/v1/shape`

<a href="api/docs/img/flow.jpg" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/img/gatekeeper-flow.dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="./docs/img/gatekeeper-flow.png" />
    <img alt="Gatekeeper flow diagramme" src="./docs/img/gatekeeper-flow.jpg"
        width="100%"
    />
  </picture>
</a>

#### Gatekeeper endpoint

1. the user makes a `POST` request to `POST /gatekeeper/:table` with some authentication credentials and a shape definition in the request parameters; the gatekeeper is then responsible for authorising the user's access to the shape
2. if access is granted, the gatekeeper generates a shape-scoped auth token and returns it to the client
3. the client can then use the auth token when connecting to the Electric HTTP API, via the proxy endpoint

#### Proxy endpoint

4. the proxy validates the JWT auth token and verifies that the shape definition in the token matches the shape being requested; if so it reverse-proxies the request onto Electric
5. Electric then handles the request as normal, sending a response back through the proxy to the client
6. the client can then process the data and make additional requests using the same auth token (step 3); if the auth token expires or is rejected, the client starts again (step 1).


## How to run

There are three ways to run this example:

1. with the [API as both gatekeeper and proxy](#1-api-as-gatekeeper-and-proxy)
2. with the [API as gatekeeper and Caddy as the proxy](#2-caddy-as-proxy)
3. with the [API as gatekeeper and an edge function as the proxy](#3-edge-function-as-proxy)

It makes sense to run through these in order.

### Pre-reqs

You need [Docker Compose](https://docs.docker.com/compose/) and [curl](https://curl.se). We also (optionally) pipe into `jq` for JSON formatting.

The instructions below all use the same [`./docker-compose.yaml`](./docker-compose.yaml) file in the root of this repo. With a different set of services and environment variables.

> [!Tip] Running Postgres and Electric
> All of the configurations are based on running Postgres and Electric. This is handled for you by the `./docker-compose.yaml`. However, if you're unfamiliar with how Electric works, it may be useful to go through the [Quickstart](https://electric-sql.com/docs/quickstart) and [Installation](https://electric-sql.com/docs/guides/installation) guides.

### 1. API as gatekeeper and proxy

Build the local API image:

```shell
docker compose build api
```

Run `postgres`, `electric` and the `api` services:

```console
$ docker compose up postgres electric api
...
gatekeeper-api-1 | 10:22:20.951 [info] == Migrated 20241108150947 in 0.0s
gatekeeper-api-1 | 10:22:21.453 [info] Running ApiWeb.Endpoint with Bandit 1.5.7 at :::4000 (http)
gatekeeper-api-1 | 10:22:21.455 [info] Access ApiWeb.Endpoint at http://localhost:4000
```

In a new terminal, make a `POST` request to the gatekeeper endpoint:

```console
$ curl -sX POST "http://localhost:4000/gatekeeper/items" | jq
{
  "headers": {
    "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJKb2tlbiIsImV4cCI6MTczMTUwMjM2OSwiaWF0IjoxNzMxNDk1MTY5LCJpc3MiOiJKb2tlbiIsImp0aSI6IjMwM28zYmx0czN2aHYydXNiazAwMDJrMiIsIm5iZiI6MTczMTQ5NTE2OSwic2hhcGUiOnsibmFtZXNwYWNlIjpudWxsLCJ0YWJsZSI6Iml0ZW1zIiwid2hlcmUiOm51bGwsImNvbHVtbnMiOm51bGx9fQ.8UZehIWk1EDQ3dJ4ggCBNkx9vGudfrD9appqs8r6zRI"
  },
  "url": "http://localhost:3000/proxy/v1/shape",
  "table": "items"
}
```

You'll see that the response contains:

- the proxy `url` to make shape requests to (`http://localhost:4000/proxy/v1/shape`)
- the request parameters for the shape we're requesting, in this case `"table": "items"`
- an `authorization` header, containing a `Bearer <token>`

Copy the auth token and set it to an env var:

```shell
export AUTH_TOKEN="<token>"
```

First let's make a `GET` request to the proxy endpoint *without* the auth token:

```console
$ curl "http://localhost:4000/proxy/v1/shape?table=items&offset=-1"
Forbidden
```

Now let's add the authorization header:

```console
$ curl --header "Authorization: Bearer ${AUTH_TOKEN}" \
      "http://localhost:4000/proxy/v1/shape?table=items&offset=-1"
[]
```

Success! We got an empty response because there are no `items` in the database. If you like,
you can create some, e.g. using `psql`:

```console
~ psql "postgresql://postgres:password@localhost:54321/electric?sslmode=disable"
psql (16.4)
Type "help" for help.

electric=# \d
               List of relations
 Schema |       Name        | Type  |  Owner
--------+-------------------+-------+----------
 public | items             | table | postgres
 public | schema_migrations | table | postgres
(2 rows)

electric=# select * from items;
 id | value | inserted_at | updated_at
----+-------+-------------+------------
(0 rows)

electric=# insert into items (id, inserted_at, updated_at) values (gen_random_uuid(), now(), now());
INSERT 0 1
electric=# \q
```

Now re-run the same request and you'll get data:

```console
$ curl -s --header "Authorization: Bearer ${AUTH_TOKEN}" \
      "http://localhost:3000/v1/shape?table=items&offset=-1" | jq
[
  {
    "key": "\"public\".\"items\"/\"b702e58e-9364-4d54-9360-8dda20cb4405\"",
    "value": {
      "id": "b702e58e-9364-4d54-9360-8dda20cb4405",
      "value": null,
      "inserted_at": "2024-11-13 10:45:33",
      "updated_at": "2024-11-13 10:45:33"
    },
    "headers": {
      "operation": "insert",
      "relation": [
        "public",
        "items"
      ]
    },
    "offset": "0_0"
  }
]
```

So far we've shown things working with Electric's lower-level [HTTP API](https://electric-sql.com/docs/api/http). You can also setup the [higher level clients](https://electric-sql.com/docs/api/clients/typescript) to use an auth token. See the [auth guide](https://electric-sql.com/docs/guides/auth) for more details.

### 2. Caddy as proxy

Run `postgres`, `electric`, `api` and `caddy` services with the `.env.caddy` env file:

```shell
docker compose --env-file .env.caddy up postgres electric api caddy
```

As above, use the gatekeeper endpoint to generate an auth token. Note that the `url` has changed to point to Caddy:

```console
$ curl -sX POST "http://localhost:4000/gatekeeper/items" | jq
{
  "headers": {
    "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJKb2tlbiIsImV4cCI6MTczMTUwNDUxNCwiaWF0IjoxNzMxNDk3MzE0LCJpc3MiOiJKb2tlbiIsImp0aSI6IjMwM283OGd1cWIxZ240ODhmazAwMDJnNCIsIm5iZiI6MTczMTQ5NzMxNCwic2hhcGUiOnsibmFtZXNwYWNlIjpudWxsLCJ0YWJsZSI6Iml0ZW1zIiwid2hlcmUiOm51bGwsImNvbHVtbnMiOm51bGx9fQ.EkSj-ro9-3chGyuxlAglOjo0Ln8t4HLVLQ4vCCNjMCY"
  },
  "url": "http://localhost:8080/v1/shape",
  "table": "items"
}
```

Copy the auth token and set it to an env var:

```shell
export AUTH_TOKEN="<token>"
```

Make an unauthorised shape request to Caddy:

```console
$ curl -v "http://localhost:8080/v1/shape?table=items&offset=-1"
*   Trying 127.0.0.1:8080...
* Connected to localhost (127.0.0.1) port 8080 (#0)
> GET /v1/shape?table=items&offset=-1 HTTP/1.1
> Host: localhost:8080
> User-Agent: curl/8.1.2
> Accept: */*
>
< HTTP/1.1 401 Unauthorized
< Server: Caddy
< Date: Wed, 13 Nov 2024 11:30:22 GMT
< Content-Length: 0
<
* Connection #0 to host localhost left intact
```

Make an authorised request to Caddy with the auth token:

```console
$ curl --header "Authorization: Bearer ${AUTH_TOKEN}" \
      "http://localhost:8080/v1/shape?table=items&offset=-1"
[]
```

Try making a request for a different shape:

```console
$ curl --header "Authorization: Bearer ${AUTH_TOKEN}" \
      "http://localhost:4000/proxy/v1/shape?table=items&offset=-1&where=true"
Forbidden
```

As you can see, Caddy is validating the shape request against the shape definition signed into the auth token. Take a look at the [`./caddy/Caddyfile`](./caddy/Caddyfile) for more details.

### 3. Edge function as proxy

