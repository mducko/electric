defmodule Electric.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false
  alias Electric.Postgres.ReplicationClient
  require Logger

  use Application

  @impl true
  def start(_type, _args) do
    :erlang.system_flag(:backtrace_depth, 50)

    {storage_module, init_params} = Application.fetch_env!(:electric, :storage)

    with {:ok, storage_opts} <- storage_module.shared_opts(init_params) do
      storage = {storage_module, storage_opts}
      shape_cache = {Electric.ShapeCache, storage: storage}

      children =
        if Application.fetch_env!(:electric, :environment) != :test do
          [
            Electric.Telemetry,
            {storage_module, storage_opts},
            {Registry,
             name: Registry.ShapeChanges, keys: :duplicate, partitions: System.schedulers_online()},
            shape_cache,
            {Electric.Replication.ShapeLogStorage,
             registry: Registry.ShapeChanges, shape_cache: shape_cache},
            {Postgrex,
             Application.fetch_env!(:electric, :database_config) ++
               [
                 name: Electric.DbPool,
                 pool_size: 10
               ]},
            {ReplicationClient,
             Application.fetch_env!(:electric, :database_config) ++
               [
                 init_opts: [
                   publication_name: "electric_publication",
                   transaction_received:
                     {Electric.Replication.ShapeLogStorage, :store_transaction, []}
                 ]
               ]},
            {Bandit,
             plug:
               {Electric.Plug.Router,
                storage: storage,
                registry: Registry.ShapeChanges,
                shape_cache: {Electric.ShapeCache, []},
                inspector: {Electric.Postgres.Inspector, Electric.DbPool},
                long_poll_timeout: 20_000,
                max_age: Application.fetch_env!(:electric, :cache_max_age),
                stale_age: Application.fetch_env!(:electric, :cache_stale_age)},
             port: 3000}
          ]
        else
          []
        end

      # See https://hexdocs.pm/elixir/Supervisor.html
      # for other strategies and supported options
      opts = [strategy: :one_for_one, name: Electric.Supervisor]
      Supervisor.start_link(children, opts)
    end
  end
end