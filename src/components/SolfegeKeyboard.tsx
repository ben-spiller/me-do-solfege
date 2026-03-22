import React, { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import { SemitoneOffset, MAJOR_SCALE_PITCH_CLASSES, semitonesToSolfege } from "@/utils/audio";
import { getNoteButtonColor } from "@/utils/noteStyles";

export type Overlay = { 
  note: SemitoneOffset; 
  isCorrect?: boolean; 
  /** Optional: Message to show below the overlaid note and tick, e.g. with information about the score change */
  message?: string;
  /** Optional place to store the timeout. Always clear existing timeout before resetting  */
  timeoutId?: number | NodeJS.Timeout;
}

interface SolfegeKeyboardProps {
  onNotePress: (note: SemitoneOffset, isVariation?: boolean) => void;
  disabled: boolean;
  overlay?: Overlay;
  /** Range of semitones to display [min, max]. Default [0, 12] for one octave. */
  range?: [SemitoneOffset, SemitoneOffset];
  /** If true, show chord labels with Roman numerals. */
  showChordLabels?: boolean;
  /** Optional suffix to append to main button labels (e.g., " +variation") */
  buttonSuffix?: string;
  /** Array of selected note pitch classes (0-11) for visual indication when using this control for selecting */
  selectedNotes?: number[];
}

const SolfegeKeyboard: React.FC<SolfegeKeyboardProps> = ({
  onNotePress,
  overlay = null,
  disabled = false,
  range = [0, 11],
  showChordLabels = false,
  buttonSuffix = "",
  selectedNotes,
}) => {
  // Helper to check if a note is selected (by pitch class 0-11)
  const isNoteSelected = (pitch: SemitoneOffset) => {
    if (!selectedNotes) return false; // If no selection tracking, none appear selected
    const pitchClass = ((pitch % 12) + 12) % 12;
    return selectedNotes.includes(pitchClass);
  };
  // Shared spacing constants used by both the solfege column and the chromatic column.
  // Units: rem for the layout math, and Tailwind margin classes for the button stack.
  const WIDE_GAP_REM = 0.8; // rem - used for both solfege stack spacing and chromatic math
  const NARROW_GAP_REM = 0.2; // rem - used for smaller spacing

  // Generate all major scale notes within the range
  const generateMajorScaleNotes = () => {
    const notes: SemitoneOffset[] = [];
    const [minSemitone, maxSemitone] = range;
    
    // Generate notes for each octave in range
    const minOctave = Math.floor(minSemitone / 12);
    const maxOctave = Math.ceil(maxSemitone / 12);
    
    for (let octave = minOctave; octave <= maxOctave; octave++) {
      for (const pitch of MAJOR_SCALE_PITCH_CLASSES) {
        const semitone = octave * 12 + pitch;
        if (semitone >= minSemitone && semitone <= maxSemitone) {
          notes.push(semitone as SemitoneOffset);
        }
      }
    }
    
    return notes.sort((a, b) => b - a); // Reverse for high-to-low display
  };

  // Generate all chromatic notes within the range
  const generateChromaticNotes = () => {
    const notes: SemitoneOffset[] = [];
    const [minSemitone, maxSemitone] = range;
    const chromaticPitches = [1, 3, 6, 8, 10];
    
    const minOctave = Math.floor(minSemitone / 12);
    const maxOctave = Math.ceil(maxSemitone / 12);
    
    for (let octave = minOctave; octave <= maxOctave; octave++) {
      for (const pitch of chromaticPitches) {
        const semitone = octave * 12 + pitch;
        if (semitone >= minSemitone && semitone <= maxSemitone) {
          notes.push(semitone as SemitoneOffset);
        }
      }
    }
    
    return notes.sort((a, b) => b - a); // Reverse for high-to-low display
  };

  // Heights (rem)
  const buttonHeightREM = 4*14/16; // matches h-16
  const flatButtonHeightREM = 3*10/12; // matches h-12

  const majorScaleNotes = generateMajorScaleNotes();
  const chromaticNotes = generateChromaticNotes();
  
  // Ref for scrolling to the main octave center
  const mainOctaveCenterRef = useRef<HTMLDivElement>(null);
  
  // State for handling long press
  const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isPressedRef = useRef(false);
  
  // Scroll to center the main octave on mount
  useEffect(() => {
    if (mainOctaveCenterRef.current) {
      mainOctaveCenterRef.current.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center' 
      });
    }
  }, []);

  const shouldIgnoreTouchEvent  = (e: React.MouseEvent | React.TouchEvent) => {
    if (e.nativeEvent instanceof TouchEvent) {
      const touch = e.nativeEvent.changedTouches[0]; // the finger that ended
      const endTarget = document.elementFromPoint(touch.clientX, touch.clientY);
      if (endTarget !== e.currentTarget) {
        return true; // Touch moved away to another element
      } 
    }
    return false;
  }

  // Handle note press with variation detection
  const handleButtonPress = (pitch: SemitoneOffset, event: React.MouseEvent | React.TouchEvent) => {
    if (disabled || shouldIgnoreTouchEvent(event)) return;

    // clear any previous timer before proceeding
    if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }

    // Check if ctrl/cmd key is pressed
    const isCtrlPressed = 'ctrlKey' in event ? event.ctrlKey || event.metaKey : false;
    
    if (isCtrlPressed) {
      // Immediate variation trigger
      onNotePress(pitch, true);
      event.preventDefault(); // Prevent any default behavior, e.g. duplicate triggering for touch+mouse
    } else {
      // Normal press - will be triggered on release if not long press
      isPressedRef.current = true;
      
      // Start long press timer
      pressTimerRef.current = setTimeout(() => {
        if (isPressedRef.current) {
          // Long press detected - trigger variation
          onNotePress(pitch, true);
          event.preventDefault(); // Prevent any default behavior, e.g. duplicate triggering for touch+mouse
          isPressedRef.current = false; // Prevent normal press on release
        }
      }, 500);
    }
  };
  
  const handleButtonRelease = (pitch: SemitoneOffset, event: React.MouseEvent | React.TouchEvent) => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    
    // If still marked as pressed, it's a normal click (not long press or ctrl)
    if (isPressedRef.current && !shouldIgnoreTouchEvent(event)) {
      onNotePress(pitch, false);
      event.preventDefault(); // Prevent any default behavior, e.g. duplicate triggering for touch+mouse
    }
    
    isPressedRef.current = false;
  };
  
  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current);
      }
    };
  }, []);

  // Build a map from diatonic note -> top offset (rem), and compute total column height
  const diatonicTopMap = new Map<SemitoneOffset, number>();
  let accTop = 0;
  for (let i = 0; i < majorScaleNotes.length; i++) {
    const note = majorScaleNotes[i];
    diatonicTopMap.set(note, accTop);
    const next = majorScaleNotes[i + 1];
    if (next !== undefined) {
      const isWide = Math.abs(note - next) === 2;
      accTop += buttonHeightREM + (isWide ? WIDE_GAP_REM : NARROW_GAP_REM);
    }
  }
  const totalHeightRem = accTop + buttonHeightREM;

  // Randomly decide whether do (index 0) or the next note (index 1) sits on a line.
  // Then every other (alternating) note gets a line. Stable per mount.
  const lineOffset = useMemo(() => Math.round(Math.random()), []);

  // Compute staff-line positions: center of every other diatonic button
  const staffLinePositions = useMemo(() => {
    const positions: number[] = [];
    for (let i = 0; i < majorScaleNotes.length; i++) {
      if ((i % 2) === lineOffset) {
        const top = diatonicTopMap.get(majorScaleNotes[i]);
        if (top !== undefined) {
          positions.push(top + buttonHeightREM / 2);
        }
      }
    }
    return positions;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [majorScaleNotes.length, lineOffset, buttonHeightREM]);

  // Check if a note is in the main octave (0-11)
  const isInMainOctave = (semitone: SemitoneOffset) => semitone >= 0 && semitone <= 11;

  return (
    <div className="relative" style={{ margin: "8px" }}>
      {/* Staff lines spanning full width */}
      {staffLinePositions.map((top, i) => (
        <div
          key={i}
          className="absolute left-0 right-0 border-t border-muted-foreground/20 pointer-events-none z-0"
          style={{ top: `${top}rem` }}
        />
      ))}
      <div className="flex gap-2 relative z-10"> 
      {/* Main (major scale / solfege) notes column */}
      <div className="flex-1 flex flex-col">
        {majorScaleNotes.map((pitch, index) => {
          let solfege = semitonesToSolfege(pitch, true, showChordLabels);
          
          // Calculate gap - wider except between Mi-Fa (natural semitone)
          const nextPitch = majorScaleNotes[index + 1];
          const hasChromatic = nextPitch !== undefined && Math.abs(pitch - nextPitch) === 2;
          // use rem-based inline margin so units match the chromatic column math
          const gapStyle = { marginBottom: `${hasChromatic ? WIDE_GAP_REM : NARROW_GAP_REM}rem` } as React.CSSProperties;
          
          const isLastPressed = overlay?.note === pitch;
          const inMainOctave = isInMainOctave(pitch);
          const isCenterOfMainOctave = pitch === 5; // Fa is roughly in the center of main octave
          
          return (
            <div 
              key={pitch} 
              ref={isCenterOfMainOctave ? mainOctaveCenterRef : null}
              className={`relative ${!inMainOctave ? 'flex justify-end' : ''}`} 
              style={index < majorScaleNotes.length - 1 ? gapStyle : undefined}
            >
              {/* Should maybe use onPointer instead */}
              <Button
                onMouseDown={(e) => handleButtonPress(pitch, e)}
                onMouseUp={(e) => handleButtonRelease(pitch, e)}
                onMouseLeave={(e) => handleButtonRelease(pitch, e)}
                onTouchStart={(e) => handleButtonPress(pitch, e)}
                onTouchEnd={(e) => handleButtonRelease(pitch, e)}
                className={`h-14 text-xl font-bold text-white relative ${getNoteButtonColor(semitonesToSolfege(pitch))} ${!inMainOctave ? 'opacity-70 w-2/3' : 'w-full'} ${isNoteSelected(pitch) ? 'ring-[4px] ring-primary' : ''}`}
                disabled={disabled}
              >
                {solfege}{buttonSuffix}
                {isLastPressed && overlay?.isCorrect !== null && (
                  <div className={`absolute inset-0 flex flex-col items-center justify-center animate-scale-in`}>
                    <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-lg">
                      {overlay?.isCorrect ? (
                        <Check className="w-8 h-8 text-green-500" strokeWidth={3} />
                      ) : (
                        <X className="w-8 h-8 text-red-500" strokeWidth={3} />
                      )}
                    </div>
                    {overlay?.message && (
                      <div className={`mt-1 px-2 py-0.5 rounded text-xs font-bold shadow ${
                        overlay?.isCorrect 
                          ? 'bg-green-100 text-green-700' 
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {overlay?.message}
                      </div>
                    )}
                  </div>
                )}
              </Button>
            </div>
          );
        })}
      </div>
      
      {/* Chromatic notes column */}
      <div className="w-36 relative" style={{ height: `${totalHeightRem}rem` }}>
        {/* Chromatic notes positioned in gaps */}
        {chromaticNotes.map((pitch) => {
          // Determine the diatonic note just above this chromatic note within the stack
          const indexAbove = majorScaleNotes.findIndex((n, i) => n > pitch && (i === majorScaleNotes.length - 1 || majorScaleNotes[i + 1] <= pitch));
          if (indexAbove === -1 || indexAbove >= majorScaleNotes.length - 1) return null;

          const noteAbove = majorScaleNotes[indexAbove];
          const noteBelow = majorScaleNotes[indexAbove + 1];

          const gapWidth = Math.abs(noteAbove - noteBelow) === 2 ? WIDE_GAP_REM : NARROW_GAP_REM;

          // Top position is centered in the gap between the two diatonic notes
          const topOfAbove = diatonicTopMap.get(noteAbove) ?? 0;
          const top = topOfAbove + buttonHeightREM + (gapWidth / 2) - (flatButtonHeightREM / 2);

          const isLastPressed = overlay?.note === pitch;
          const inMainOctave = isInMainOctave(pitch);

          return (
            <div key={pitch} className="absolute w-full" style={{ top: `${top}rem` }}>
              <div className={''}>
                <Button
                  onMouseDown={(e) => handleButtonPress(pitch, e)}
                  onMouseUp={(e) => handleButtonRelease(pitch, e)}
                  onMouseLeave={(e) => handleButtonRelease(pitch, e)}
                  onTouchStart={(e) => handleButtonPress(pitch, e)}
                  onTouchEnd={(e) => handleButtonRelease(pitch, e)}
                  className={`h-10 text-lg font-bold text-white relative ${getNoteButtonColor(semitonesToSolfege(pitch))} ${!inMainOctave ? 'opacity-70 w-full' : 'w-full'} ${isNoteSelected(pitch) ? 'ring-4 ring-primary ring-offset-2' : ''}`}
                  disabled={disabled}
                  title={semitonesToSolfege(pitch, true, showChordLabels)}
                >
                ♭ ({semitonesToSolfege(pitch, false, showChordLabels)})
                {isLastPressed && overlay?.isCorrect !== null && (
                  <div className={`absolute inset-0 flex flex-col items-center justify-center animate-scale-in`}>
                    <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-lg">
                      {overlay?.isCorrect ? (
                        <Check className="w-7 h-7 text-green-500" strokeWidth={3} />
                      ) : (
                        <X className="w-7 h-7 text-red-500" strokeWidth={3} />
                      )}
                    </div>
                    {overlay?.message && (
                      <div className={`mt-1 px-2 py-0.5 rounded text-xs font-bold shadow ${
                        overlay?.isCorrect 
                          ? 'bg-green-100 text-green-700' 
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {overlay?.message}
                      </div>
                    )}
                  </div>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
};

export default SolfegeKeyboard;
