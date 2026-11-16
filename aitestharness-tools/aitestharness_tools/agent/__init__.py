"""Agent 契约层：任务派发单 / 产物接收 / 降级说明（§17.3 / §10.9 的粘合实现）。"""
from .tasks import (CONTRACT_TASKS, TASK_CONTRACTS, contract_of, dispatch,
                    explain_degrade, submit, task_catalog)

__all__ = ["TASK_CONTRACTS", "CONTRACT_TASKS", "dispatch", "submit",
           "explain_degrade", "contract_of", "task_catalog"]
