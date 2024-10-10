defmodule Electric.TenantSupervisor do
  @moduledoc """
  Responsible for managing tenant processes
  """
  use DynamicSupervisor

  alias Electric.Tenant

  require Logger

  def start_link(_opts) do
    DynamicSupervisor.start_link(__MODULE__, [], name: Electric.DynamicTenantSupervisor)
  end

  def start_tenant(opts) do
    Logger.debug(fn -> "Starting tenant for #{Access.fetch!(opts, :tenant_id)}" end)
    DynamicSupervisor.start_child(Electric.DynamicTenantSupervisor, {Tenant.Supervisor, opts})
  end

  @impl true
  def init(_opts) do
    Logger.debug(fn -> "Starting #{__MODULE__}" end)
    DynamicSupervisor.init(strategy: :one_for_one)
  end
end