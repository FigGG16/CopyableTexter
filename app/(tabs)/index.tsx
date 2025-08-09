import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const DEFAULT_CHUNK_SIZE = 500;

const normalizeText = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');

const splitByLength = (raw: string, size: number) => {
  const s = Math.max(1, size | 0);
  const arr = Array.from(raw); // Unicode-safe
  const out: string[] = [];
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s).join(''));
  return out;
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
                <Text style={styles.chunkMeta}>第 {index + 1} 段 · {item.length} 字</Text>
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
  chunkMeta: { color: '#666' },
  copyBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#007AFF' },
  copyBtnCopied: { backgroundColor: '#E0F0FF', borderColor: '#007AFF' },
  copyBtnText: { color: '#007AFF', fontWeight: '600' },
  counterBar: { backgroundColor: '#F6F8FA', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  counterText: { color: '#333', fontWeight: '600' },
  copiedText: { marginTop: 4, color: '#007AFF' },
});
