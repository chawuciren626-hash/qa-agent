"""aitestharness_tools — AITestHarness 各阶段确定性工具包

原则（对齐 v3 方案）：
- 每个工具都是确定性代码（零 LLM），LLM 的活由 agent 层做；
- 工具只做结构化、校验、计算，输入输出均为 IR（YAML/JSON）；
- 每个工具可独立 CLI 调用，也可作为库函数被 agent 编排层引用。
"""
