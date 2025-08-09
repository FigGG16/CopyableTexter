import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const DEFAULT_CHUNK_SIZE = 1000;

const normalizeText = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');

const splitByLength = (raw: string, size: number) => {
  const s = Math.max(1, size | 0);
  const arr = Array.from(raw); // Unicode-safe
  const out: string[] = [];
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s).join(''));
  return out;
};

type Chapter = { title: string; start: number; end: number };

type HeadingSets = { majors: Chapter[]; minors: Chapter[] };

const extractHeadings = (t: string): HeadingSets => {
  if (!t) return { majors: [], minors: [] };

  // Normalize newlines and spaces (convert CRLF, remove BOM elsewhere; also normalize full-width spaces)
  const text = t.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '').replace(/[\u00A0\u3000]+/g, ' ');
  const lines = text.split('\n');

  // Precompute UTF-16 line start offsets to align with JS string indices
  const lineStarts: number[] = new Array(lines.length);
  let cu = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = cu;
    cu += lines[i].length + 1; // +1 for the removed "\n"
  }

  // ====== Patterns ======
  // Major headings
  const reCNOrdinal = '[零一二三四五六七八九十百千两]+';
  const reDigit = '\\d+';
  const reCNUnit = '(章|卷|部分|篇|编|讲|节|回)';

  const reMajorCN = new RegExp(`^\\s*(第(${reCNOrdinal}|${reDigit})${reCNUnit}).*`); // 第X章/第X卷/第X部分…
  const reMajorPart = /^\s*(Part)\s*\d+.*$/i;                                     // Part 1 …
  const reMajorChapterEN = /^\s*(Chapter)\s*\d+.*$/i;                              // Chapter 1 …
  const reMajorSectionCN = new RegExp(`^\\s*(第(${reCNOrdinal}|${reDigit})部分).*`); // 第一部分 …（冗余保险）

  // Special stand-alone majors commonly found at the beginning or between parts
  const reMajorSpecial = /^(\s*(目录|章节概要与阅读导图|前言|序言|序|引言|作者序|译者序|译者后记|作者简介|推荐序|中文版序|结语|尾声|致\s*谢|致谢|术语表|参考文献|重要参考资料|网上附录|附录[一二三四五六七八九十\dA-Z]*|Contents|Foreword(?::.*)?|Introduction|Concluding Reflections)\s*)$/i;

  // Minor headings
  // Numeric prefixed small sections like: 01 标题 / 1.2 小结 / 1、标题 / 1．标题 / 1. 标题
  const reMinorNumeric = /^(\s*([0-9]{1,3}|[０-９]{1,3})([\.．、:]|\s+)\s*[^\s].*)$/;
  // Known textbook sub-headings like "本章小结/简答题/计算题/网上练习/网上资料/小结/思考题"
  const reMinorKeywords = /^(\s*(本章小结|小结|简答题|计算题|思考题|网上练习|网上资料|练习题|重点回顾)\s*)$/;

  // A short, punctuation-light line near a blank line often indicates a subheading
  const isLikelyTitleLine = (L: string) => {
    if (!L) return false;
    // avoid typical sentences
    if (/[。！？!?…]+/.test(L)) return false;
    const len = L.length;
    return len >= 2 && len <= 40;
  };

  type RawHit = { title: string; start: number; type: 'major' | 'minor' };
  const hits: RawHit[] = [];

  const isMajor = (L: string) => reMajorCN.test(L) || reMajorPart.test(L) || reMajorChapterEN.test(L) || reMajorSectionCN.test(L) || reMajorSpecial.test(L);

  const isMinor = (L: string, i: number) => {
    if (!L) return false;
    if (isMajor(L)) return false;
    if (reMinorNumeric.test(L)) return true;
    if (reMinorKeywords.test(L)) return true;
    // Heuristic around blank lines
    if (!isLikelyTitleLine(L)) return false;
    const prevBlank = i > 0 && lines[i - 1].trim() === '';
    const nextBlank = i + 1 < lines.length && lines[i + 1].trim() === '';
    return prevBlank || nextBlank;
  };

  // Scan
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const L = raw.trim();
    if (!L) continue;
    if (isMajor(L)) {
      hits.push({ title: L, start: lineStarts[i], type: 'major' });
      continue;
    }
    if (isMinor(L, i)) {
      hits.push({ title: L, start: lineStarts[i], type: 'minor' });
    }
  }

  if (hits.length === 0) return { majors: [], minors: [] };
  hits.sort((a, b) => a.start - b.start);

  const majors: Chapter[] = [];
  const minors: Chapter[] = [];

  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].start;
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    const c: Chapter = { title: hits[i].title, start, end };
    if (hits[i].type === 'major') majors.push(c); else minors.push(c);
  }

  return { majors, minors };
};

export default function HomeScreen() {
  const [text, setText] = useState<string>('');
  const [chunkSize, setChunkSize] = useState<number>(DEFAULT_CHUNK_SIZE);
  const [fileName, setFileName] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [lastCopiedIndex, setLastCopiedIndex] = useState<number>(-1);
  const [previewEnabled, setPreviewEnabled] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(6);
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  const [collapsedSet, setCollapsedSet] = useState<Set<number>>(new Set());

  const insets = useSafeAreaInsets();

  const chunks = useMemo(() => splitByLength(text, chunkSize), [text, chunkSize]);

  const headingSets = useMemo(() => extractHeadings(text), [text]);
  const chapters = headingSets.majors;
  const subChapters = headingSets.minors;

  const chunkStarts = useMemo(() => {
    // Compute per-chunk start offsets in UTF-16 code units by replaying the split on code points
    const points = Array.from(text);
    const offsetsCU: number[] = new Array(points.length + 1);
    offsetsCU[0] = 0;
    for (let i = 0; i < points.length; i++) {
      // Each code point may occupy 1 or 2 UTF-16 code units; string length gives code units
      offsetsCU[i + 1] = offsetsCU[i] + points[i].length;
    }
    const starts: number[] = [];
    for (let i = 0; i < points.length; i += chunkSize) {
      starts.push(offsetsCU[i]);
    }
    return starts;
  }, [text, chunkSize]);

  const chapterTitlesForChunks = useMemo(() => {
    if (chapters.length === 0) return new Array(chunks.length).fill('');
    const titles: string[] = new Array(chunks.length);
    let ci = 0; // chapter index pointer
    for (let i = 0; i < chunks.length; i++) {
      const pos = chunkStarts[i];
      while (ci + 1 < chapters.length && pos >= chapters[ci + 1].start) ci++;
      const ch = chapters[ci];
      titles[i] = pos >= ch.start && pos < ch.end ? ch.title : '';
    }
    return titles;
  }, [chapters, chunks, chunkStarts]);

  const subChapterTitlesForChunks = useMemo(() => {
    if (subChapters.length === 0) return new Array(chunks.length).fill('');
    const titles: string[] = new Array(chunks.length);
    let si = 0; // subchapter index pointer
    for (let i = 0; i < chunks.length; i++) {
      const pos = chunkStarts[i];
      while (si + 1 < subChapters.length && pos >= subChapters[si + 1].start) si++;
      const sc = subChapters[si];
      titles[i] = pos >= sc.start && pos < sc.end ? sc.title : '';
    }
    return titles;
  }, [subChapters, chunks, chunkStarts]);

  React.useEffect(() => {
    if (previewEnabled) {
      // In preview mode, items can be expanded beyond 3 lines
      setCollapsedSet(new Set());
    } else {
      // In full mode, items can be collapsed to 3 lines
      setExpandedSet(new Set());
    }
  }, [previewEnabled]);

  const pickAndRead = useCallback(async () => {
    try {
      setLoading(true);
      const res = await DocumentPicker.getDocumentAsync({ type: 'text/plain' });
      if ((res as any).canceled) return;
      const asset = (res as any).assets?.[0];
      if (!asset?.uri) return;
      setFileName(asset.name || '');
      let content = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
      content = normalizeText(content);
      setText(content);
    } catch (e: any) {
      console.warn(e);
      Alert.alert('读取失败', e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const copyChunk = useCallback(async (t: string, index: number) => {
    try {
      await Clipboard.setStringAsync(t);
      if (lastCopiedIndex !== index) {
        setLastCopiedIndex(index);
      }
    } catch (e: any) {
      // Removed Alert on copy failure as per instructions
    }
  }, [lastCopiedIndex]);

  const toggleItem = useCallback((index: number) => {
    if (previewEnabled) {
      setExpandedSet(prev => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
    } else {
      setCollapsedSet(prev => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
    }
  }, [previewEnabled]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top','left','right','bottom']}>
      <View style={[styles.container, { paddingBottom: 16 + insets.bottom }]}>
      <Text style={styles.title}>Copyable Texter</Text>

      <View style={styles.row}>
        <Pressable style={styles.button} onPress={pickAndRead} disabled={loading}>
          <Text style={styles.buttonText}>{loading ? '读取中…' : '选择 TXT 文件'}</Text>
        </Pressable>
        <View style={styles.sizeBox}>
          <Text style={styles.label}>每段字数</Text>
          <TextInput
            keyboardType="number-pad"
            value={String(chunkSize)}
            onChangeText={(v) => setChunkSize(Math.max(1, parseInt(v || '1', 10)))}
            style={styles.input}
          />
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.previewBox}>
          <Text style={styles.label}>缩略显示</Text>
          <Switch value={previewEnabled} onValueChange={setPreviewEnabled} />
        </View>
        <View style={styles.fontBox}>
          <Text style={styles.label}>字体xxx</Text>
          <Pressable onPress={() => setFontSize(v => Math.max(2, v - 1))} style={styles.miniBtn}>
            <Text style={styles.miniBtnText}>A-</Text>
          </Pressable>
          <Text style={styles.sizeValue}>{fontSize}</Text>
          <Pressable onPress={() => setFontSize(v => Math.min(48, v + 1))} style={styles.miniBtn}>
            <Text style={styles.miniBtnText}>A+</Text>
          </Pressable>
        </View>
      </View>

      {!!fileName && (
        <Text style={styles.fileInfo} numberOfLines={1}>
          文件：{fileName}（共 {text.length} 字） | 分成 {chunks.length} 段
        </Text>
      )}

      <View style={styles.counterBar}>
        <Text style={styles.counterText}>当前总段落数：{chunks.length}</Text>
        {lastCopiedIndex >= 0 && lastCopiedIndex < chunks.length && (
          <Text style={styles.copiedText} numberOfLines={1} ellipsizeMode="tail">
            已复制：第 {lastCopiedIndex + 1} 段 · {chunks[lastCopiedIndex].length} 字 —— {chunks[lastCopiedIndex]}
          </Text>
        )}
      </View>

      {text.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>请先选择一个 .txt 文件</Text>
        </View>
      ) : (
        <FlatList
          data={chunks}
          keyExtractor={(_, i) => `chunk-${i}`}
          contentContainerStyle={[styles.listContent, { paddingBottom: Math.max(24, 24 + insets.bottom) }]}
          renderItem={({ item, index }) => (
            <View style={styles.card}>
              {(() => {
                const isExpanded = expandedSet.has(index);
                const isCollapsed = collapsedSet.has(index);
                const numberOfLines = previewEnabled
                  ? (isExpanded ? undefined : 3)
                  : (isCollapsed ? 3 : undefined);
                return (
                  <Pressable onPress={() => toggleItem(index)}>
                    <Text
                      style={[styles.chunkText, { fontSize, lineHeight: Math.round(fontSize * 1.5) }]}
                      numberOfLines={numberOfLines}
                      ellipsizeMode="tail"
                    >
                      {item}
                    </Text>
                  </Pressable>
                );
              })()}
              <View style={styles.cardFooter}>
                <Text style={styles.chunkMeta} numberOfLines={2} ellipsizeMode="tail">
                  第 {index + 1} 段 · {item.length} 字
                  {chapterTitlesForChunks[index] ? ` · 章节：${chapterTitlesForChunks[index]}` : ''}
                  {subChapterTitlesForChunks[index] ? ` · 小节：${subChapterTitlesForChunks[index]}` : ''}
                </Text>
                <Pressable 
                  onPress={() => copyChunk(item, index)} 
                  style={lastCopiedIndex === index ? [styles.copyBtn, styles.copyBtnCopied] : styles.copyBtn}
                >
                  <Text style={styles.copyBtnText}>{lastCopiedIndex === index ? '已复制' : '复制'}</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
      )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#fff' },
  container: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  button: { backgroundColor: '#007AFF', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  buttonText: { color: '#fff', fontWeight: '600' },
  sizeBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  previewBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fontBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#007AFF' },
  miniBtnText: { color: '#007AFF', fontWeight: '600' },
  sizeValue: { minWidth: 28, textAlign: 'center', color: '#333' },
  label: { fontSize: 14, color: '#444' },
  input: { width: 80, borderWidth: 1, borderColor: '#ccc', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
  fileInfo: { color: '#555', marginBottom: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#777' },
  listContent: { paddingBottom: 24 },
  card: { borderWidth: 1, borderColor: '#e3e3e3', borderRadius: 10, padding: 12, marginBottom: 10, backgroundColor: '#fff' },
  chunkText: { fontSize: 16, lineHeight: 24, marginBottom: 10 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chunkMeta: { color: '#666', flex: 1, marginRight: 8,fontSize:10 },
  copyBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#007AFF', flexShrink: 0 },
  copyBtnCopied: { backgroundColor: '#E0F0FF', borderColor: '#007AFF' },
  copyBtnText: { color: '#007AFF', fontWeight: '600' },
  counterBar: { backgroundColor: '#F6F8FA', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  counterText: { color: '#333', fontWeight: '600' },
  copiedText: { marginTop: 4, color: '#007AFF' },
});
