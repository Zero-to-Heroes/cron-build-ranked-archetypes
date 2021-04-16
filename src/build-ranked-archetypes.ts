/* eslint-disable @typescript-eslint/no-use-before-define */
import { AllCardsService } from '@firestone-hs/reference-data';
import { decode } from 'deckstrings';
import { ServerlessMysql } from 'serverless-mysql';
import SqlString from 'sqlstring';
import { gzipSync } from 'zlib';
import { ArchetypeResults, ArchetypeStats, DeckList } from './archetype-stats';
import { getConnection } from './db/rds';
import { S3 } from './db/s3';
import { groupByFunction, http } from './utils/util-functions';

const escape = SqlString.escape;
const THRESHOLD = 10;
const s3 = new S3();
const allCards: AllCardsService = new AllCardsService();

// This example demonstrates a NodeJS 8.10 async handler[1], however of course you could use
// the more traditional callback-style handler.
// [1]: https://aws.amazon.com/blogs/compute/node-js-8-10-runtime-now-available-in-aws-lambda/
export default async (event): Promise<any> => {
	const lastBattlegroundsPatch = await getLastPatch();

	await allCards.initializeCardsDb();
	const mysql = await getConnection();

	const statsForLastPatch: readonly ArchetypeResults[] = await buildStatsForLastPatch(
		mysql,
		lastBattlegroundsPatch.date,
	);

	mysql.end();

	const stats: ArchetypeStats = {
		lastPatch: statsForLastPatch,
	};

	const stringResults = JSON.stringify(stats);
	console.log('stringified results');
	const gzippedResults = gzipSync(stringResults);
	console.log('zipped results');
	await s3.writeFile(gzippedResults, 'static.zerotoheroes.com', 'api/ranked-decks.json', 'application/json', 'gzip');
	console.log('new stats saved to s3');

	return { statusCode: 200, body: null };
};

const buildStatsForLastPatch = async (mysql: ServerlessMysql, date: string): Promise<readonly ArchetypeResults[]> => {
	const query = `
		SELECT 
			gameFormat, 
		    playerArchetypeId, 
		    playerDeckstring,  
		    SUM(CASE WHEN result = 'won' THEN 1 ELSE 0 END) AS wins,
		    SUM(CASE WHEN result = 'lost' THEN 1 ELSE 0 END) AS losses
		FROM ranked_decks
		WHERE creationDate > ${escape(date)}
		GROUP BY gameFormat, playerArchetypeId, playerDeckstring;
	`;
	console.log('running query', query);
	const dbResults: readonly InternalResult[] = await mysql.query(query);

	const groupedByArchetype = groupByFunction((result: InternalResult) => result.playerArchetypeId)(dbResults);
	return Object.keys(groupedByArchetype)
		.map(archetypeId => {
			const statsForArchetype = groupedByArchetype[archetypeId];
			const groupedByFormat: { [format: string]: readonly InternalResult[] } = groupByFunction(
				(result: InternalResult) => result.gameFormat,
			)(statsForArchetype);
			return Object.keys(groupedByFormat).map(format => {
				const wins = groupedByFormat[format].map(result => result.wins).reduce((a, b) => a + b, 0);
				const losses = groupedByFormat[format].map(result => result.losses).reduce((a, b) => a + b, 0);
				const decklists: readonly DeckList[] = groupedByFormat[format]
					.map(result => ({
						deckstring: result.playerDeckstring,
						cards: explodeCards(result.playerDeckstring),
						wins: result.wins,
						losses: result.losses,
					}))
					// Keep only the decks that we can decode
					.filter(result => result.cards?.length);
				return {
					archetypeId: archetypeId,
					gameFormat: format,
					decklists: decklists,
					wins: wins,
					losses: losses,
				} as ArchetypeResults;
			}) as readonly ArchetypeResults[];
		})
		.reduce((a, b) => a.concat(b), [])
		.filter(result => result.wins + result.losses > THRESHOLD);
};

const explodeCards = (deckstring: string): readonly string[] => {
	try {
		const deck = decode(deckstring);
		return deck
			? deck.cards
					// [dbfid, count] pair
					.map(pair => Array(pair[1]).fill(pair[0]))
					.reduce((a, b) => a.concat(b), [])
					.map(dbfId => allCards.getCardFromDbfId(dbfId))
					.map(card => card.id)
			: [];
	} catch (e) {
		console.log('could not decod', deckstring);
		return null;
	}
};

const getLastPatch = async (): Promise<Patch> => {
	const patchInfo = await http(`https://static.zerotoheroes.com/hearthstone/data/patches.json`);
	const structuredPatch = JSON.parse(patchInfo);
	return structuredPatch.patches.find(patch => patch.number === structuredPatch.currentBattlegroundsMetaPatch);
};

interface Patch {
	readonly number: number;
	readonly version: string;
	readonly name: string;
	readonly date: string;
}

interface InternalResult {
	readonly gameFormat: 'standard' | 'wild';
	readonly playerArchetypeId: string;
	readonly playerDeckstring: string;
	readonly wins: number;
	readonly losses: number;
}
