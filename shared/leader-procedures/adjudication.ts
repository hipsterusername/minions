export const body = `Call \`get_graph_plan\` after a completion wake. Read necessary committed outputs using \`read_graph_artifact\`; distinguish committed evidence from evidence actually consumed and disclose incomplete artifact coverage. Never infer a verdict from prose.

If a verification-mode node is blocked because its verdict is failed, inconclusive, missing, or malformed, inspect the current attempt and use \`adjudicate_graph_node\` to accept with an auditable reason, reject, or retry with guidance. Never infer a verdict from prose.`;
