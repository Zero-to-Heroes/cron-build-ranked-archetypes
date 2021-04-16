export interface ArchetypeStats {
	readonly lastPatch: readonly ArchetypeResults[];
}

export interface ArchetypeResults {
	readonly archetypeId: string;
	readonly gameFormat: 'standard' | 'wild';
	readonly wins: number;
	readonly losses: number;
	readonly decklists: readonly DeckList[];
}

export interface DeckList {
	readonly deckstring: string;
	readonly cards: readonly string[];
	readonly wins: number;
	readonly losses: number;
}
