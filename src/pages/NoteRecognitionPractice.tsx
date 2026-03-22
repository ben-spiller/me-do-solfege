import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { stopSounds, MidiNoteNumber, SemitoneOffset, playNote, playSequence, semitonesToSolfege, midiToNoteName, noteNameToMidi, startDrone, stopDrone, setDroneVolume, semitonesToOneOctave, keypressToSemitones, startAudio, handleSemitoneModifierUp, handleSemitoneModifierDown } from "@/utils/audio";
import { ConfigData, ExerciseType } from "@/config/ConfigData";
import { saveCurrentConfiguration } from "@/utils/settingsStorage";
import { getGlobalSettings } from "@/utils/globalSettingsStorage";
import { getNoteButtonColor, getOctaveIndicator } from "@/utils/noteStyles";
import { SessionHistory, STORED_NEEDS_PRACTICE_PAIRS, STORED_FREQUENTLY_WRONG_PAIRS, STORED_FREQUENTLY_CONFUSED_PAIRS } from "./History";
import SolfegeKeyboard, { Overlay } from "@/components/SolfegeKeyboard";
import { PracticeHeader } from "@/components/PracticeHeader";
import tuningFork from "@/assets/tuning-fork.svg";

const PracticeView = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const FEEDBACK_MILLIS = 1000;
  // put an upper bound on the severity of each one to avoid it getting crazy
  const maxNeedsPractice = 10;
  
  // Initialize settings from query params (if present), otherwise from state or defaults
  const searchParams = new URLSearchParams(location.search);
  const settings = searchParams.toString().length > 0 
    ? ConfigData.fromQueryParams(searchParams)
    : new ConfigData(location.state as Partial<ConfigData>);
  
  const globalSettings = getGlobalSettings();
  
  // Calculate note duration based on tempo (BPM)
  // At 60 BPM, each beat = 1 second; at 120 BPM, each beat = 0.5 seconds
  const noteDuration = 60 / settings.tempo;
  const noteGap = noteDuration * 0.15; // Gap is 15% of note duration

  /** The MIDI note of the root/do note for this particular exercise (may be randomly selected based on the config) */  
  const [rootMidi, setRootMidi] = useState<MidiNoteNumber>(noteNameToMidi(settings.rootNotePitch)+(Math.floor(Math.random() * 6)-3));

  /** The previous question sequence, to avoid duplication */
  const prevSequence = useRef<SemitoneOffset[]>([]);
  const totalSequencesAnswered = useRef(0);
  // Track mistakes in the current round and whether the previous round was perfect (no mistakes)
  const roundMistakesRef = useRef<number>(0);
  const previousRoundWasPerfectRef = useRef<boolean | null>(null);

  const [isAudioLoading, setAudioLoading] = useState(false);
  const [isAudioLoaded, setAudioLoaded] = useState(false);

  /** The notes for the current question (relative to the root) */
  const [sequence, setSequence] = useState<SemitoneOffset[]>([]);
  const sequenceItems = useRef<Array<{ note: number; duration: number; gapAfter: number }>>([]);
  const [currentPosition, setCurrentPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [lastPressedOverlay, setLastPressedOverlay] = useState<Overlay | null>(null);
  const [lastAnswerInfo, setLastAnswerInfo] = useState<string | null>(null);
  /** Number of note presses that were correct */
  const [correctAttempts, setCorrectAttempts] = useState(0);
  /** Total number of note presses */
  const [totalAttempts, setTotalAttempts] = useState(0);
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [droneVolume, setDroneVolumeState] = useState(-8); // default volume in dB
  const [isPlayingReference, setIsPlayingReference] = useState(false);

  /** Count of wrong answers: Maps "prevNote,note" -> count (prevNote="" for note at start of sequence) */
  const wrongNotePairs = useRef<Map<string, number>>((() => {
    const stored = localStorage.getItem(STORED_FREQUENTLY_WRONG_PAIRS);
    return stored ? new Map(JSON.parse(stored)) : new Map();
  })());  
  /** Pairs of notes that are confused with each other (bidirectional): Maps "noteA,noteB" -> count where noteA < noteB */
  const confusedPairs = useRef<Map<string, number>>((() => {
    const stored = localStorage.getItem(STORED_FREQUENTLY_CONFUSED_PAIRS);
    return stored ? new Map(JSON.parse(stored)) : new Map();
  })());
  /** 2-note pairs that need more practice */
  const needsPractice = useRef<Map<string, number>>((() => {
    const stored = localStorage.getItem(STORED_NEEDS_PRACTICE_PAIRS+settings.exerciseType);
    return stored ? new Map(JSON.parse(stored)) : new Map();
  })());
  /** Snapshot of needsPractice at session start for history tracking */
  const needsPracticeInitialSnapshot = useRef<Record<string, number>>(
    Object.fromEntries(needsPractice.current.entries())
  );
  /** Initial needsPracticeTotal at session start (undefined if no prior data) */
  const initialNeedsPracticeTotal = useRef<number | undefined>((() => {
    const stored = localStorage.getItem(STORED_NEEDS_PRACTICE_PAIRS+settings.exerciseType);
    if (!stored) return undefined;
    const map = new Map<string, number>(JSON.parse(stored));
    return map.size > 0 ? Array.from(map.values()).reduce((a, b) => a + b, 0) : undefined;
  })());

 const isQuestionComplete = (currentPosition: number): boolean => {
    return currentPosition >= settings.numberOfNotes 
      || (settings.exerciseType === ExerciseType.SingleNoteRecognition && currentPosition >= 1); 
  }

  // Helper to persist practice data to localStorage
  const savePracticeData = () => {
    localStorage.setItem(STORED_FREQUENTLY_WRONG_PAIRS, JSON.stringify(Array.from(wrongNotePairs.current.entries())));
    localStorage.setItem(STORED_FREQUENTLY_CONFUSED_PAIRS, JSON.stringify(Array.from(confusedPairs.current.entries())));
    localStorage.setItem(STORED_NEEDS_PRACTICE_PAIRS+settings.exerciseType, JSON.stringify(Array.from(needsPractice.current.entries())));
  };


  /** Called to actually start the first round of questions once all audio is initialized */
  async function startPractice() {
    setAudioLoaded(true);
    // Save current configuration in case we came directly to this page from a bookmark (without Home/settings page)
    saveCurrentConfiguration(settings);

    if (settings.droneType !== "none") {
        // Start drone if configured
        startDrone(rootMidi, droneVolume);
      }
        
      await handlePlayReference();

      // Add gap before exercise
      await new Promise(resolve => setTimeout(resolve, 800));
      
      wrongNotePairs.current.clear();
      confusedPairs.current.clear();

      // Now start the first round
      startNewRound();
  }
  
  useEffect(() => {
    startAudio(settings.pickInstrument(), true, isAudioLoaded, setAudioLoading, startPractice);    
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup drone on unmount
  useEffect(() => {
    return () => {
      stopDrone();
    };
  }, []);

  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      handleSemitoneModifierUp(e);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Next button shortcuts
      if ((e.key === 'n' || e.key === 'Enter') && isQuestionComplete(currentPosition)) {
        e.preventDefault();
        startNewRound();
        return;
      }

      // Play again shortcut
      if (e.key === 'a' && isAudioLoaded && !isPlaying) {
        e.preventDefault();
        handlePlayAgain();
        return;
      }

      // Reference shortcut
      if (e.key === 'e' && isAudioLoaded && !isPlaying && !isPlayingReference) {
        e.preventDefault();
        handlePlayReference();
        return;
      }
      // Track semitone modifier keys (+/=/-) 
      handleSemitoneModifierDown(e);


      let note = keypressToSemitones(e);
      if (note !== null) {
        e.preventDefault();
        handleNotePress(note);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    }
  }, [currentPosition, settings.numberOfNotes, rootMidi, sequence, isAudioLoaded, isPlaying, isPlayingReference]);

  const startNewRound = () => {
    setLastPressedOverlay(null);
    setLastAnswerInfo(null);
    prevSequence.current = [...sequence];
    //console.log("Previous sequence saved: "+JSON.stringify(prevSequence.current.map(n => semitonesToSolfege(n))));
    const newSequence = generateNextNoteSequence();
    setSequence(newSequence as number[]);
  // After generating the new sequence, reset the previous-round flag so it only applies to the next round
  previousRoundWasPerfectRef.current = null;
  // Reset mistakes counter for the upcoming round
  roundMistakesRef.current = 0;
    
    // Generate durations for this sequence
    const durations = generateSequenceDurations(newSequence.length + settings.playExtraNotes);
    
    // Generate extra notes deterministically
    const extraNotesOffsets: SemitoneOffset[] = [];
    if (settings.playExtraNotes > 0) {
      const pool = settings.getNotePool();
      
      for (let i = 0; i < settings.playExtraNotes; i++) {
        const randomIndex = Math.floor(Math.random() * pool.length);
        extraNotesOffsets.push(pool[randomIndex]);
      }
    }
    
    // Build full SequenceItems array (main sequence + extra notes)
    const items = [
      ...newSequence.map((offset, i) => ({
        note: rootMidi + offset,
        duration: durations[i],
        gapAfter: noteGap
      })),
      ...extraNotesOffsets.map((offset, i) => ({
        note: rootMidi + offset,
        duration: durations[settings.numberOfNotes + i],
        gapAfter: noteGap
      }))
    ];
    sequenceItems.current = items;
    
    setCurrentPosition(0);
    // measure each questions separately, so we can ignore times when the user left it for ages
    // start the timer just before we play the notes
    setQuestionStartTime(Date.now());
    playSequenceWithDelay();
  };

  const generateSequenceDurations = (length: number): number[] => {
    if (settings.rhythm !== "random") {
      // Fixed rhythm - all notes same duration
      return Array(length).fill(noteDuration);
    }
    
    // Random rhythm - choose from 3 duration options
    const durationOptions = [noteDuration, noteDuration * 1.5, noteDuration * 2];
    return Array.from({ length }, () => {
      const randomIndex = Math.floor(Math.random() * durationOptions.length);
      return durationOptions[randomIndex];
    });
  };

  const playSequenceWithDelay = async () => {
    stopSounds();
    setIsPlaying(true);
    console.debug('Playing sequence:', sequenceItems.current);
    
    await playSequence(sequenceItems.current);
    
    setIsPlaying(false);
  };

  /** Uses whichever octave was most recently used in the current sequence for the specified note, if any */
  const moveNoteToMostRecentOctave = (note: SemitoneOffset): SemitoneOffset => {
    let result = note;
    let index = 0;
    for (const seqNote of sequence) {
      if (index++ > currentPosition) break; // don't look into the future
      if (semitonesToOneOctave(note) === semitonesToOneOctave(seqNote))
        result = seqNote;
    }

    return result;
  }

  const handleNotePress = (selectedNote: SemitoneOffset) => {
    if (isQuestionComplete(currentPosition)) { // at the end, just play whatever they pressed
      stopSounds();
      playNote(moveNoteToMostRecentOctave(selectedNote)+rootMidi);
      return;
    }

    const correctNote = sequence[currentPosition];
    setTotalAttempts(totalAttempts + 1);

    // Check if the notes match
    const isCorrect = semitonesToOneOctave(selectedNote) === semitonesToOneOctave(correctNote);

    // We'll build the overlay after updating needsPractice so it can include the delta
    let lastAnswerInfo: string;

    // Update practice tracking
    const correctInterval = correctNote;
    const prevInterval = currentPosition === 0 ? '' : sequence[currentPosition - 1];
    const pairKey = `${prevInterval},${correctInterval}`;

    if (isCorrect) {
      // Play the correct note from the sequence (correct octave)
      stopSounds();
      playNote(correctNote+rootMidi);

      // Decrement needsPractice for correct answer
      const oldCount = needsPractice.current.get(pairKey) || 0;
      let newCount = oldCount;
      if (oldCount > 0) {
        newCount = oldCount - 1;
        if (newCount <= 0) {
          needsPractice.current.delete(pairKey);
          newCount = 0;
        } else {
          needsPractice.current.set(pairKey, newCount);
        }
      }
      console.log("Needs practice for "+pairKey+" decreased from "+oldCount+" to "+newCount);
      lastAnswerInfo = getLastAnswerInfo(true, oldCount, newCount);

      setCorrectAttempts(correctAttempts + 1);
      setCurrentPosition(currentPosition + 1);

      // once we completed this question, add to the elapsed time 
      if (isQuestionComplete(currentPosition + 1)) {
        totalSequencesAnswered.current += 1;

        if (Date.now() - questionStartTime > 60000) {
          // avoid counting up wildly big times
          console.log("Ignoring time spent on this question as user probably stepped away from the app");
        } else {
          setElapsedSeconds(elapsedSeconds + (Math.floor((Date.now() - questionStartTime) / 1000)));
        }
        // Record whether this round finished with zero mistakes
        previousRoundWasPerfectRef.current = (roundMistakesRef.current === 0);
      }
    } else {
      // Play the wrong note that was pressed
      stopSounds();
      playNote(moveNoteToMostRecentOctave(selectedNote)+rootMidi);

      // Update wrong answer count
      wrongNotePairs.current.set(pairKey, (wrongNotePairs.current.get(pairKey) || 0) + 1);

      // Track confused pairs (bidirectional - normalize so smaller note comes first)
      const note1 = Math.min(correctInterval, selectedNote);
      const note2 = Math.max(correctInterval, selectedNote);
      const confusedPairKey = `${note1},${note2}`;
      confusedPairs.current.set(confusedPairKey, (confusedPairs.current.get(confusedPairKey) || 0) + 1);

      // Track that this round had a mistake
      roundMistakesRef.current = (roundMistakesRef.current || 0) + 1;

      // Add to needsPractice for the CORRECT note (+3 if first wrong answer or in the danger zone, +1 otherwise)
      const oldNeedsPracticeCount = (needsPractice.current.get(pairKey) || 0);
      const newNeedsPracticeCount = Math.min(maxNeedsPractice, oldNeedsPracticeCount + (
        (oldNeedsPracticeCount <3) ? +3 : +1));
      needsPractice.current.set(pairKey, newNeedsPracticeCount);
      lastAnswerInfo = getLastAnswerInfo(false, oldNeedsPracticeCount, newNeedsPracticeCount);
      console.log("Needs practice for "+pairKey+" increased from "+oldNeedsPracticeCount+" to "+newNeedsPracticeCount);
      
      // Also increment needsPractice for the INCORRECT note that was entered
      // but NOT once the backlog gets big as then it just builds a frustration loop
      if (Array.from(needsPractice.current.values()).reduce((a, b) => a + b, 0) < 25) {
        const incorrectPairKey = `${prevInterval},${selectedNote}`;
        const incorrectNeedsPracticeCount = (needsPractice.current.get(incorrectPairKey) || 0);
        needsPractice.current.set(incorrectPairKey, Math.min(maxNeedsPractice, Math.min(maxNeedsPractice, incorrectNeedsPracticeCount + 1)));
        console.log("Needs practice for "+incorrectPairKey+" increased from "+incorrectNeedsPracticeCount+" to "+(incorrectNeedsPracticeCount + 1));
      }
    }

    // Show overlay (including needs-practice delta) and schedule automatic clear
    clearTimeout(lastPressedOverlay?.timeoutId);
    setLastPressedOverlay({ note: selectedNote, isCorrect,  
      timeoutId: setTimeout(() => {
        setLastPressedOverlay(null);
        if (isCorrect && !isQuestionComplete(currentPosition)) {
          setLastAnswerInfo(null); // after this timeout, clear the info for correct answer (wrong )
        }
    }, FEEDBACK_MILLIS) });
    setLastAnswerInfo(lastAnswerInfo);
  };

  const getLastAnswerInfo = (isCorrect: boolean, oldCount: number, newCount: number): string | null => {
    if ((oldCount !== newCount) || newCount === maxNeedsPractice) {
      return `${newCount === maxNeedsPractice ? maxNeedsPractice + " (max)" : newCount} more reps needed for this interval`;
    }
    return null;
  }

  const handlePlayAgain = () => {
    playSequenceWithDelay();
  };

  const handlePlayReference = async () => {
    const globalSettings = getGlobalSettings();
    setIsPlayingReference(true);
    if (globalSettings.referenceType === "arpeggio") {
      const doMidi = rootMidi;
      const arpeggio = [
        doMidi,           // do
        doMidi + 4,       // mi
        doMidi + 7,       // sol
        doMidi + 12,      // do (octave up)
        doMidi + 7,       // sol
        doMidi + 4,       // mi
        doMidi,           // do
      ];
      await playSequence(arpeggio, 0.03, noteDuration*1);
    } else {
      await playSequence([rootMidi], 0, 2.0);
    }
    setIsPlayingReference(false);
  };

  const handleFinish = () => {
    savePracticeData();
    saveCurrentConfiguration(settings);
    // Save session data if at least one question was answered
    if (totalSequencesAnswered.current > 0) {
      const session = {
        sessionDate: Date.now(),
        score: Math.round((correctAttempts / totalAttempts) * 100),
        avgSecsPerAnswer: totalSequencesAnswered.current > 0 ? (elapsedSeconds / totalSequencesAnswered.current) : 0,
        totalAttempts,
        correctAttempts,
        totalSeconds: elapsedSeconds,

        needsPracticeCount: needsPractice.current.size,
        needsPracticeTotalSeverity: Array.from(needsPractice.current.values()).reduce((a, b) => a + b, 0),

        exerciseName: settings.exerciseType,
        settings: settings, // don't need to copy this because we won't be mutating it anyway
        
        needsPracticeInitialMap: needsPracticeInitialSnapshot.current,
        needsPracticeFinalMap: Object.fromEntries(needsPractice.current.entries()),
      } satisfies SessionHistory;
      
      // Append to sessions array
      const sessionsStr = localStorage.getItem('practiceSessions');
      const sessions = sessionsStr ? JSON.parse(sessionsStr) : [];
      sessions.push(session);
      localStorage.setItem('practiceSessions', JSON.stringify(sessions));
      
      navigate("/history");
    } else {
      navigate("/");
    }
  };

  const handleDroneVolumeChange = (value: number[]) => {
    const newVolume = value[0];
    setDroneVolumeState(newVolume);
    setDroneVolume(newVolume);
  };

  const generateNextNoteSequence = (): SemitoneOffset[] => {
    const pool: SemitoneOffset[] = settings.getNotePool();
    
    const sequence: number[] = [];
    const reason: string[] = [];
    for (let i = 0; i < settings.numberOfNotes; i++) {
      let [n, r] = pickNextNote(pool, sequence);
      sequence.push(n);
      reason.push(r);
    }
    
    console.log("Note sequence is: "+JSON.stringify(sequence.map(n => semitonesToSolfege(n)))+" due to "+reason.join(','));

    return sequence;
  };

  function randomInt(max: number): number {
    return Math.floor(Math.random() * max);
  }

  /** Pick the next semitone for the current sequence, and a string explaining why it was chosen */
  function pickNextNote(pool: SemitoneOffset[], currentSequence: SemitoneOffset[]): [SemitoneOffset, string] {
      // Choices for this note. Start with the current pool
      pool = [...pool];
      //console.log("Initial pool: "+JSON.stringify(pool));

      const prevNote = currentSequence.length === 0 ? null : currentSequence[currentSequence.length - 1];

      if (prevNote === null) {
          // Avoid same starting note as immediate previous exercise, so we can't end up with duplication
          if (prevSequence.current.length > 0 && pool.length > 1) {
            console.debug("Filtering out previous starting note: "+semitonesToSolfege(prevSequence.current[0]));
            pool = pool.filter(note => note !== prevSequence.current[0]);
          }
      } 
      else // not the first note, so filter by interval 
      {
        let intervalFiltered = pool.filter(note => {
          const distance = Math.abs(note - prevNote);
          return distance >= settings.consecutiveIntervals[0] && distance <= settings.consecutiveIntervals[1]; 
        });
        if (intervalFiltered.length === 0) { console.log("No possible notes after "+semitonesToSolfege(prevNote)); }
        else { pool = intervalFiltered; }
      }

      console.debug("Next note pool after filtering: "+JSON.stringify(pool));

      // Selection logic based on previous round performance:
      // - If the previous round was perfect (no mistakes), usually prefer picking a challenging note from needsPractice
      if (previousRoundWasPerfectRef.current === true && Math.random() < 0.9) {
        const practiceNote = pickFromNeedsPractice(pool, prevNote);
        if (practiceNote !== null) {
          console.debug("  picked from needs-practice due to prior perfect round: "+ semitonesToSolfege(practiceNote));
          return [practiceNote, "needs-practice-prior-success"];
        }
        // fall through to random if no suitable practice note available
      }

      // - If the previous round was not perfect, pick a random note (give the user an easier / varied follow-up)
      // Since brain learns better with reinforcement of known items no constant failure
      return [pool[randomInt(pool.length)], "random-due-to-prior-mistakes"];
 
      // Default behavior (no prior-round preference): probabilistically pick from needsPractice when available
  //     if (Math.random() < (needsPractice.current.size > 2 ? 0.7 : 0.4)) {
  //       const practiceNote = pickFromNeedsPractice(pool, prevNote);
  //       if (practiceNote !== null) {
  //         console.debug("  picked from needs-practice: "+ semitonesToSolfege(practiceNote));
  //         return [practiceNote, "needs-practice"];
  //       }
  //     }
  //     // Pick randomly if not
  //     return [pool[randomInt(pool.length)], "random"];      
  }

  /** Weighted random selection from needsPractice, biased towards higher counts. Returns null if there's no suitable needsPractice note */
  function pickFromNeedsPractice(pool: SemitoneOffset[], prevNote: SemitoneOffset | null): SemitoneOffset | null {
    // Filter needsPractice entries that match the current prevNote and are in the pool
    const validPairs: [string, number][] = [];
    for (const [pairKey, count] of needsPractice.current.entries()) {
      const [storedPrev, storedNote] = pairKey.split(',');
      const storedPrevNum = storedPrev === '' ? null : parseInt(storedPrev);
      const storedNoteNum = parseInt(storedNote);
      
      if (storedPrevNum === prevNote && pool.includes(storedNoteNum)) {
        validPairs.push([pairKey, count]);
      }
    }
    if (validPairs.length === 0) return null;

    // Weight by count (higher count = more likely to be selected)
    const totalWeight = validPairs.reduce((sum, [_, count]) => sum + count, 0);
    let random = Math.random() * totalWeight;
    
    for (const [pairKey, count] of validPairs) {
      random -= count;
      if (random <= 0) {
        const [_, storedNote] = pairKey.split(',');
        return parseInt(storedNote);
      }
    }

    // Fallback to last item
    const [_, lastNote] = validPairs[validPairs.length - 1][0].split(',');
    return parseInt(lastNote);
  }
  


  return (<>
    {!isAudioLoaded ? (
        <Card>
          <CardContent className="pt-6">
            <Button 
              onClick={() => startAudio(settings.pickInstrument(), true, isAudioLoaded, setAudioLoading, startPractice)} 
              disabled={isAudioLoading}
              className="w-full"
              size="lg"
            >
              {isAudioLoading ? "Loading..." : "Load sounds"}
            </Button>
          </CardContent>
        </Card>
      ) 
  : (<>
    
   <div className="min-h-screen bg-background flex flex-col p-4 max-w-2xl mx-auto">
      <PracticeHeader
        showReference={true}
        correctAttempts={correctAttempts}
        needsPracticeTotal={Array.from(needsPractice.current.values()).reduce((a, b) => a + b, 0)}
        initialNeedsPracticeTotal={initialNeedsPracticeTotal.current}
        totalAttempts={totalAttempts}
        elapsedSeconds={elapsedSeconds}
        started={isAudioLoaded}
        isPlaying={isPlaying}
        isPlayingReference={isPlayingReference}
        droneType={settings.droneType}
        droneVolume={droneVolume}
        onPlayAgain={handlePlayAgain}
        onPlayReference={handlePlayReference}
        onFinish={handleFinish}
        onDroneVolumeChange={handleDroneVolumeChange}
      />

      <div className="w-full max-w-2xl space-y-4">
        {/* Musical note button div at the top */}
        <SolfegeKeyboard
          onNotePress={handleNotePress}
          overlay={lastPressedOverlay}
          disabled={isPlayingReference}
        />

        {/* Progress card */}
        <Card className="relative">
          <CardHeader>
            <CardTitle className="text-center">
              <div className="flex items-center justify-center gap-4">
                <div>
                  {isPlayingReference ? (<><img src={tuningFork} alt="Tuning Fork" className="w-6 h-6 mr-2 inline-block" />
                    <span className="animate-pulse">Playing reference "{midiToNoteName(rootMidi)}"...</span>
                  </>) : (
                    (isQuestionComplete(currentPosition) ? <span>Correct! 🎉</span> : <span>Identify the notes</span>)
                  )}
                </div>

                {isQuestionComplete(currentPosition) && (
                  <span className="flex items-center gap-3">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button onClick={startNewRound} size="lg">
                            Next
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Press N or Enter</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </span>
                )}
              </div>

            </CardTitle>
          </CardHeader>
          <CardContent>                
            <div className="flex gap-2 justify-center flex-wrap">
              {Array.from({ length: settings.numberOfNotes }).map((_, index) => {
                const isAnswered = index < currentPosition;
                const noteSolfege = isAnswered ? (semitonesToSolfege(sequence[index])) : "?";
                const octaveIndicator = isAnswered ? getOctaveIndicator(sequence[index]) : "";
                const colorClass = isAnswered ? getNoteButtonColor(noteSolfege) : "bg-muted";
                
                return (
                <div key={index} className="flex align-items-center gap-4">
                  <div
                    className={`w-12 h-12 rounded-lg flex items-center justify-center font-bold text-sm transition-colors text-white relative ${colorClass}`}
                  >
                    {noteSolfege}
                    {octaveIndicator && (
                      <span title={octaveIndicator+" octave"} className="absolute top-0.5 right-0.5 text-[10px] font-bold bg-black/30 px-1 rounded">
                        {octaveIndicator}
                      </span>
                    )}
                  </div>
                  <br/>

                </div>);
              })}
            </div>
            <div className="text-center mt-4 text-sm">
              {lastAnswerInfo}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
    </>)}</>);
};

export default PracticeView;
