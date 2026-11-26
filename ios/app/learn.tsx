import { ScrollView, Text, View, Button, ActivityIndicator, Alert, Linking, Pressable } from 'react-native';
import { useEffect, useState } from 'react';
import {
  BONUS_ALL_STEPS,
  XP_CORRECT,
  buildMission,
  completeMission,
  createStats,
  resourcesFor,
  stepXp,
  subjectList,
  topicsFor,
  type LearnMission,
  type LearnStats,
  type LearnStep,
} from '../services/learning';
import { listLearningProgress, saveLearningProgress } from '../services/pocketbase';

type LearnPhase = 'subjects' | 'topics' | 'resources' | 'mission' | 'result';

export default function LearnScreen() {
  const [phase, setPhase] = useState<LearnPhase>('subjects');
  const [subjectId, setSubjectId] = useState<string>('');
  const [topicId, setTopicId] = useState<string>('');
  const [mission, setMission] = useState<LearnMission | null>(null);
  const [missionStep, setMissionStep] = useState(0);
  const [stepResult, setStepResult] = useState<{ correct: boolean; xp: number } | null>(null);
  const [missionScore, setMissionScore] = useState<{ xp: number; correctCount: number; answered: number }>({ xp: 0, correctCount: 0, answered: 0 });
  const [stats, setStats] = useState<LearnStats>(createStats());
  const [saveMsg, setSaveMsg] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const [matchSel, setMatchSel] = useState<string | null>(null);
  const [matchMatched, setMatchMatched] = useState<Record<string, boolean>>({});

  const subjects = subjectList();

  useEffect(() => {
    void (async () => {
      try {
        const r = await listLearningProgress();
        const items = (r as any)?.items as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(items) && items.length > 0) {
          setStats({ ...createStats(), ...(items[0] as any) });
        }
      } catch {
        // Offline / Backend nicht erreichbar -> lokale Defaults.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const persist = async (next: LearnStats) => {
    setStats(next);
    try {
      await saveLearningProgress(next as unknown as Record<string, unknown>);
      setSaveMsg('Fortschritt gespeichert ☁');
    } catch {
      setSaveMsg('Offline-Modus: lokal gespeichert');
    }
  };

  const startMission = () => {
    const topics = topicsFor(subjectId);
    const topic = (topicId ? topics.find((t) => t.id === topicId) : undefined) || topics[0];
    if (!topic) return;
    const m = buildMission(topic);
    setMission(m);
    setMissionStep(0);
    setStepResult(null);
    setMissionScore({ xp: 0, correctCount: 0, answered: 0 });
    setMatchSel(null);
    setMatchMatched({});
    setPhase('mission');
  };

  const finishMission = () => {
    if (!mission) return;
    const allOk = mission.steps.length > 0 && missionScore.correctCount >= mission.steps.length;
    const finalXp = missionScore.xp + (allOk ? BONUS_ALL_STEPS : 0);
    const finalScore = { ...missionScore, xp: finalXp };
    const nextStats = completeMission(stats, { xp: finalXp, correct: finalScore.correctCount, answered: finalScore.answered });
    void persist(nextStats);
    setMissionScore(finalScore);
    setPhase('result');
  };

  const answerStep = (correct: boolean, xp: number) => {
    if (!mission) return;
    const step: LearnStep = mission.steps[Math.min(missionStep, mission.steps.length - 1)];
    const gained = correct ? xp : 0;
    setStepResult({ correct, xp: gained });
    setMissionScore((prev) => ({
      xp: prev.xp + gained,
      correctCount: prev.correctCount + (correct ? 1 : 0),
      answered: prev.answered + 1,
    }));
  };

  const goNext = () => {
    if (!mission) return;
    if (missionStep < mission.steps.length - 1) {
      setMissionStep((s) => s + 1);
      setStepResult(null);
      return;
    }
    finishMission();
  };

  const subject = subjects.find((s) => s.id === subjectId) || subjects[0];
  const topics = topicsFor(subjectId);
  const topic = topics.find((t) => t.id === topicId) || topics[0];
  const step: LearnStep | null = mission && mission.steps.length > 0 ? mission.steps[Math.min(missionStep, mission.steps.length - 1)] : null;

  const matchAllDone = (pairs: { left: string; right: string }[], matched: Record<string, boolean>) => {
    const keys = pairs.map((p) => p.left);
    return keys.length > 0 && keys.every((k) => Boolean(matched[k]));
  };

  if (loading) {
    return (
      <View style={{ flex: 1, padding: 16, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 28, fontWeight: '800', marginBottom: 12 }}>Lernen</Text>

      {phase === 'subjects' && (
        <View>
          <Text style={{ color: '#7A7A7A', marginBottom: 16, fontSize: 14 }}>Wähle einen Fach – starte eine Mission und lerne spielerisch.</Text>
          <Text style={{ fontWeight: '600', marginBottom: 8 }}>XP: {stats.xp} · Level {stats.level} ({stats.title}) · 🔥 Streak: {stats.streak} Tage</Text>
          <View style={{ flexDirection: 'column', gap: 10 }}>
            {subjects.map((s) => (
              <Button
                key={s.id}
                title={`${s.icon} ${s.label}`}
                onPress={() => { setSubjectId(s.id); setPhase('topics'); }}
                color={s.color}
              />
            ))}
          </View>
        </View>
      )}

      {phase === 'topics' && (
        <View>
          <Button title="← Fächer" onPress={() => setPhase('subjects')} />
          <Text style={{ fontSize: 22, fontWeight: '700', marginTop: 16 }}>{subject.label}</Text>
          <Text style={{ color: '#7A7A7A', marginTop: 2, marginBottom: 12 }}>{subject.blurb}</Text>
          {topics.map((t) => (
            <View key={t.id} style={{ padding: 12, marginVertical: 4, backgroundColor: '#FAFAF5', borderRadius: 12 }}>
              <Text style={{ fontWeight: '600', fontSize: 16 }}>{t.title}</Text>
              <Text style={{ color: '#7A7A7A', fontSize: 12 }}>{t.subtitle}</Text>
              <Button title="📚 Mission starten" onPress={() => { setTopicId(t.id); setPhase('resources'); }} />
            </View>
          ))}
        </View>
      )}

      {phase === 'resources' && topic && (
        <View>
          <Button title="← Thema wählen" onPress={() => setPhase('topics')} />
          <Text style={{ fontSize: 22, fontWeight: '700', marginTop: 16 }}>{topic.title}</Text>
          <Text style={{ color: '#7A7A7A', marginTop: 2, marginBottom: 12 }}>{topic.subtitle}</Text>
          <Text style={{ fontWeight: '600', marginBottom: 8 }}>Passende Videos & Webseiten zum Thema</Text>
          {resourcesFor(topic.id).map((r, i) => (
            <View key={i} style={{ padding: 12, marginVertical: 6, backgroundColor: '#FAFAF5', borderRadius: 12 }}>
              <Text style={{ fontWeight: '600' }}>{r.title}</Text>
              <Text style={{ color: '#7A7A7A', fontSize: 12 }}>{r.type === 'video' ? '🎥 Video' : '🌐 Webseite'} {r.duration ? `· ${r.duration}` : ''}</Text>
              <Button title="Öffnen ↗" onPress={() => { void Linking.openURL(r.url).catch(() => undefined); }} />
            </View>
          ))}
          <Button title="🎯 Mission starten" onPress={startMission} />
        </View>
      )}

      {phase === 'mission' && step && mission && (
        <View>
          <Text style={{ fontSize: 18, fontWeight: '700' }}>{mission.title}</Text>
          <Text style={{ color: '#7A7A7A', marginTop: 4, marginBottom: 12 }}>Aufgabe {missionStep + 1} / {mission.steps.length}</Text>

          {step.type === 'mc' && (
            <View>
              <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12 }}>{step.q}</Text>
              {step.options.map((o, i) => (
                <View key={i} style={{ marginVertical: 4 }}>
                  <Button
                    title={o}
                    onPress={() => {
                      const correct = String(o) === String(step.answer);
                      answerStep(correct, correct ? XP_CORRECT.mc : 0);
                    }}
                  />
                </View>
              ))}
            </View>
          )}

          {step.type === 'cloze' && (
            <View>
              <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12 }}>{step.sentence}</Text>
              {step.options.map((o, i) => (
                <View key={i} style={{ marginVertical: 4 }}>
                  <Button
                    title={o}
                    onPress={() => {
                      const correct = String(o) === String(step.answer);
                      answerStep(correct, correct ? XP_CORRECT.cloze : 0);
                    }}
                  />
                </View>
              ))}
            </View>
          )}

          {step.type === 'match' && (
            <View>
              <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12 }}>Treffe die Paare richtig.</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '600', marginBottom: 6 }}>Begriffe</Text>
                  {step.pairs.map((p) => (
                    <Pressable
                      key={p.left}
                      onPress={() => {
                        if (matchMatched[p.left]) return;
                        setMatchSel((prev) => (prev === p.left ? null : p.left));
                      }}
                    >
                      <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: matchSel === p.left ? '#3b82f6' : '#D6D3D2', backgroundColor: matchSel === p.left ? '#EFF6FF' : '#FAFAF5', marginBottom: 6 }}>
                        <Text style={{ fontWeight: '600' }}>{p.left}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '600', marginBottom: 6 }}>Antworten / Formeln</Text>
                  {step.pairs.map((p) => (
                    <Pressable
                      key={p.right}
                      onPress={() => {
                        const pair = step.pairs.find((x) => x.right === p.right);
                        if (matchSel === null || !pair || matchSel !== pair.left) return;
                        const next = { ...matchMatched, [pair.left]: true };
                        setMatchMatched(next);
                        setMatchSel(null);
                        if (matchAllDone(step.pairs, next)) {
                          answerStep(true, stepXp(step, true));
                        }
                      }}
                    >
                      <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#D6D3D2', backgroundColor: '#FAFAF5', marginBottom: 6 }}>
                        <Text>{p.right}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>
              {!stepResult ? (
                <Text style={{ color: '#7A7A7A', fontSize: 13, marginTop: 12 }}>Tippe die Begriffe und passen sie den Antworten richtig zu.</Text>
              ) : null}
            </View>
          )}

          {stepResult ? (
            <View style={{ marginTop: 16, padding: 12, backgroundColor: '#FAFAF5', borderRadius: 12 }}>
              <Text style={{ fontWeight: '600' }}>{stepResult.correct ? '✅ Richtig!' : '❌ Leider falsch.'}</Text>
              {step.type === 'mc' || step.type === 'cloze' ? (
                <>
                  <Text style={{ marginTop: 4 }}>{step.answer}</Text>
                  <Text style={{ color: '#7A7A7A', fontSize: 13, marginTop: 4 }}>{step.explain}</Text>
                </>
              ) : null}
              <Button title="Weiter →" onPress={goNext} />
            </View>
          ) : (
            step.type !== 'match' ? (
              <View style={{ marginTop: 16 }}>
                <Button title="Zur nächsten Aufgabe →" onPress={goNext} />
              </View>
            ) : null
          )}
        </View>
      )}

      {phase === 'result' && (
        <View>
          <Text style={{ fontSize: 24, fontWeight: '800' }}>✅ Mission abgeschlossen!</Text>
          <Text style={{ marginTop: 8 }}>XP verdient: {missionScore.xp}</Text>
          <Text style={{ marginTop: 4 }}>Level {stats.level} ({stats.title}) · Gesamt-XP: {stats.xp}</Text>
          <Text style={{ marginTop: 4 }}>🔥 Streak: {stats.streak} Tage</Text>
          <Text style={{ marginTop: 4 }}>Trefferquote: {mission && mission.steps.length > 0 ? Math.round((missionScore.correctCount / mission.steps.length) * 100) : 0} %</Text>
          {saveMsg ? <Text style={{ marginTop: 8, color: '#7A7A7A' }}>{saveMsg}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
            <Button title="↻ Mission wiederholen" onPress={startMission} />
            <Button title="📚 Neues Thema" onPress={() => setPhase('subjects')} />
          </View>
        </View>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}
