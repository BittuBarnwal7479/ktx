from __future__ import annotations

import pytest

from ktx_daemon.embeddings import (
    ComputeEmbeddingBulkRequest,
    ComputeEmbeddingRequest,
    SentenceTransformersEmbeddingProvider,
    compute_embedding_bulk_response,
    compute_embedding_response,
)


class FakeEmbeddingProvider:
    name = "fake"
    dimensions = 3
    max_batch_size = 2

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def encode(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [
            [float(len(text)), float(index), 1.0] for index, text in enumerate(texts)
        ]


class ArrayLike:
    def __init__(self, value: list[float] | list[list[float]]) -> None:
        self.value = value

    def tolist(self) -> list[float] | list[list[float]]:
        return self.value


class FakeSentenceTransformerModel:
    def __init__(self) -> None:
        self.calls: list[str | list[str]] = []

    def encode(self, value: str | list[str]) -> ArrayLike:
        self.calls.append(value)
        if isinstance(value, str):
            return ArrayLike([0.1, 0.2, 0.3])
        return ArrayLike(
            [[float(index), float(len(text)), 0.5] for index, text in enumerate(value)]
        )


def test_compute_embedding_response_uses_injected_provider() -> None:
    provider = FakeEmbeddingProvider()

    response = compute_embedding_response(
        ComputeEmbeddingRequest(text="hello"),
        provider=provider,
    )

    assert response.embedding == [5.0, 0.0, 1.0]
    assert provider.calls == [["hello"]]


def test_compute_embedding_bulk_response_uses_injected_provider() -> None:
    provider = FakeEmbeddingProvider()

    response = compute_embedding_bulk_response(
        ComputeEmbeddingBulkRequest(texts=["one", "three"]),
        provider=provider,
    )

    assert response.embeddings == [[3.0, 0.0, 1.0], [5.0, 1.0, 1.0]]
    assert provider.calls == [["one", "three"]]


def test_compute_embedding_bulk_rejects_empty_texts() -> None:
    provider = FakeEmbeddingProvider()

    with pytest.raises(ValueError, match="Empty texts found at indices: 1"):
        compute_embedding_bulk_response(
            ComputeEmbeddingBulkRequest(texts=["valid", "   "]),
            provider=provider,
        )

    assert provider.calls == []


def test_compute_embedding_bulk_respects_provider_batch_size() -> None:
    provider = FakeEmbeddingProvider()

    with pytest.raises(ValueError, match="Maximum 2 texts allowed per batch"):
        compute_embedding_bulk_response(
            ComputeEmbeddingBulkRequest(texts=["one", "two", "three"]),
            provider=provider,
        )

    assert provider.calls == []


def test_sentence_transformers_provider_normalizes_single_and_bulk_outputs() -> None:
    model = FakeSentenceTransformerModel()
    provider = SentenceTransformersEmbeddingProvider(model=model)

    assert provider.encode(["hello"]) == [[0.1, 0.2, 0.3]]
    assert provider.encode(["one", "three"]) == [
        [0.0, 3.0, 0.5],
        [1.0, 5.0, 0.5],
    ]
    assert model.calls == ["hello", ["one", "three"]]
