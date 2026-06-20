/**
 * Collections provider — rewired from Vendure GraphQL to the SellRight REST shop
 * API (strangler, pass 1). Signatures unchanged; responses normalised to the
 * Vendure-ish `Collection` shape via sellright-adapters.
 */
import { srCollections, srCollectionBySlug } from '~/utils/sellright';
import {
  adaptCollections,
  adaptCollection,
  type AdaptedCollection,
} from '~/utils/sellright-adapters';

export const getCollections = async (): Promise<AdaptedCollection[]> => {
  const res = await srCollections();
  return adaptCollections(res);
};

export const getCollectionBySlug = async (slug: string): Promise<AdaptedCollection> => {
  const res = await srCollectionBySlug(slug);
  return adaptCollection(res);
};
