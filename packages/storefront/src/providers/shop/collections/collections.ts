import { Collection } from '~/generated/graphql-shop';
import {
	CollectionsDocument,
	type CollectionsQuery,
	type CollectionsQueryVariables,
	CollectionDocument,
	type CollectionQuery,
	type CollectionQueryVariables,
} from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

export const getCollections = async () => {
	const res = await requester<CollectionsQuery, CollectionsQueryVariables>(
		CollectionsDocument,
		undefined
	);
	return res?.collections.items as Collection[];
};

export const getCollectionBySlug = async (slug: string) => {
	const res = await requester<CollectionQuery, CollectionQueryVariables>(CollectionDocument, {
		slug,
	});
	return res.collection as Collection;
};
