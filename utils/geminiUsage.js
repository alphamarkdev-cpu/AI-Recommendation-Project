const formatGeminiUsage = (usageMetadata = {}) => {
  const inputTokens = usageMetadata.promptTokenCount || 0
  const outputTokens = usageMetadata.candidatesTokenCount || 0
  const totalTokens = usageMetadata.totalTokenCount || 0
  const cachedTokens = usageMetadata.cachedContentTokenCount || 0
  const thinkingTokens = usageMetadata.thoughtsTokenCount || 0
  const otherTokens = Math.max(
    totalTokens - inputTokens - outputTokens - thinkingTokens,
    0
  )

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    thinking_tokens: thinkingTokens,
    other_tokens: otherTokens,
    total_tokens: totalTokens,
    cached_tokens: cachedTokens
  }
}

module.exports = { formatGeminiUsage }
