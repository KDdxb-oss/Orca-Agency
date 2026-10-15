export function isCurrentPtyInventoryGeneration(
  connectionId: string | null | undefined,
  providerKey: string,
  inventoryGeneration: number,
  aggregateGeneration: number,
  generationByProvider: ReadonlyMap<string, number>
): boolean {
  return connectionId === undefined
    ? aggregateGeneration === inventoryGeneration &&
        ![...generationByProvider.values()].some((generation) => generation > inventoryGeneration)
    : generationByProvider.get(providerKey) === inventoryGeneration &&
        aggregateGeneration <= inventoryGeneration
}
