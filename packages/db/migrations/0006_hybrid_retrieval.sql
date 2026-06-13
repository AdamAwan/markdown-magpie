-- Approximate-nearest-neighbour index for hybrid retrieval's vector side.
-- The `embedding vector(1536)` column and the `vector` extension already exist
-- (0001_initial.sql). Cosine distance matches the query operator `<=>` used in
-- PostgresKnowledgeStore.searchByEmbedding.
CREATE INDEX IF NOT EXISTS document_sections_embedding_hnsw
  ON document_sections USING hnsw (embedding vector_cosine_ops);
