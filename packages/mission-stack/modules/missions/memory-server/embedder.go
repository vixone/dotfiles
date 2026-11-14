package main

import (
	"fmt"
	"sync"

	fastembed "github.com/bdombro/fastembed-go"
)

// Embedder wraps fastembed-go with lazy initialization and the BGE query prefix.
type Embedder struct {
	model    *fastembed.FlagEmbedding
	cacheDir string
	once     sync.Once
	initErr  error
}

func NewEmbedder(cacheDir string) *Embedder {
	return &Embedder{cacheDir: cacheDir}
}

func (e *Embedder) init() error {
	e.once.Do(func() {
		showProgress := false
		e.model, e.initErr = fastembed.NewFlagEmbedding(&fastembed.InitOptions{
			Model:                fastembed.BGEBaseENV15,
			CacheDir:             e.cacheDir,
			MaxLength:            512,
			ShowDownloadProgress: &showProgress,
		})
	})
	return e.initErr
}

// EmbedQuery embeds a single query string.
// BGE models expect "Represent this sentence: " prefix for queries via QueryEmbed.
func (e *Embedder) EmbedQuery(text string) ([]float32, error) {
	if err := e.init(); err != nil {
		return nil, fmt.Errorf("model init: %w", err)
	}
	return e.model.QueryEmbed(text)
}

// embedBatchSize is the per-ONNX-session input count. embedMaxConcurrent caps
// how many batches fastembed runs in parallel per PassageEmbed call.
const (
	embedBatchSize    = 64
	embedMaxConcurrent = 2
)

// EmbedPassages embeds passage texts (lessons/children during sync) with a
// bounded memory footprint. fastembed-go's Embed() launches one goroutine per
// batch with no concurrency limit, and each goroutine holds a full ONNX session
// plus a (batch, 512, dim) output tensor (~100MB at batch 64). Handing it the
// whole corpus at once spawns ~corpus/64 concurrent sessions and OOM-kills the
// process mid-sync before anything commits (memory-server-full-sync-oom).
//
// We slice the input into chunks of embedBatchSize*embedMaxConcurrent so each
// PassageEmbed call spawns at most embedMaxConcurrent goroutines, bounding peak
// memory to that many ONNX sessions regardless of corpus size.
func (e *Embedder) EmbedPassages(texts []string) ([][]float32, error) {
	if err := e.init(); err != nil {
		return nil, fmt.Errorf("model init: %w", err)
	}
	if len(texts) == 0 {
		return nil, nil
	}
	chunk := embedBatchSize * embedMaxConcurrent
	out := make([][]float32, 0, len(texts))
	for i := 0; i < len(texts); i += chunk {
		end := i + chunk
		if end > len(texts) {
			end = len(texts)
		}
		embs, err := e.model.PassageEmbed(texts[i:end], embedBatchSize)
		if err != nil {
			return nil, err
		}
		out = append(out, embs...)
	}
	return out, nil
}

// Close releases ONNX resources.
func (e *Embedder) Close() {
	if e.model != nil {
		e.model.Destroy()
	}
}
