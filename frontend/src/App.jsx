import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Upload, FileText, Languages, MessageSquare, Loader2, Mic, MicOff, AlertTriangle, Calendar, Info, Clock } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';

// Use CDN for worker to avoid bundler issues
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
const API_URL = 'http://localhost:5001/api';

function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState('');
  
  // Store page images for the Original tab
  const [pageImages, setPageImages] = useState([]); 

  // Tabs
  const [centerTab, setCenterTab] = useState('extracted'); // 'original' | 'extracted'
  const [rightTab, setRightTab] = useState('summary'); // 'summary' | 'details' | 'timeline' | 'ask'
  
  const [chatMessage, setChatMessage] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  
  const [isListening, setIsListening] = useState(false);
  const [voiceLang, setVoiceLang] = useState('en-IN'); // en-IN | hi-IN | mr-IN
  const [voiceError, setVoiceError] = useState(null);
  const recognitionRef = useRef(null);

  const [bnsMap, setBnsMap] = useState([]);
  // Detect speech support — Safari uses webkit prefix, Chrome uses standard
  const hasSpeechRecognition = typeof window !== 'undefined' && 
    ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);

  useEffect(() => {
    fetchDocuments();
    fetchBnsMap();
    initSpeechRecognition();
  }, []);

  const fetchDocuments = async () => {
    try {
      const response = await axios.get(`${API_URL}/documents`);
      setDocuments(response.data);
    } catch (error) {
      console.error('Failed to fetch documents', error);
    }
  };

  const fetchBnsMap = async () => {
    try {
      const response = await axios.get(`${API_URL}/bns-map`);
      setBnsMap(response.data);
    } catch (error) {
      console.error('Failed to fetch BNS map', error);
    }
  };

  // Create the SpeechRecognition instance ONCE at mount.
  // Safari requires the instance to exist before .start() is called from a user gesture.
  // Do NOT recreate the object on every call — instead update .lang in place.
  const initSpeechRecognition = () => {
    if (!hasSpeechRecognition) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = voiceLang;
    
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setChatMessage(prev => prev ? prev + ' ' + transcript : transcript);
      setVoiceError(null);
    };
    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
      if (event.error === 'not-allowed') {
        setVoiceError('Microphone access denied. Please allow mic access in your browser settings.');
      } else if (event.error === 'no-speech') {
        setVoiceError('No speech detected. Try again.');
      } else {
        setVoiceError(`Voice error: ${event.error}`);
      }
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
  };

  useEffect(() => {
    initSpeechRecognition();
  }, []); // Create once on mount

  // When voiceLang changes, just update .lang on the existing instance
  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = voiceLang;
    }
  }, [voiceLang]);

  const toggleListen = () => {
    if (!hasSpeechRecognition || !recognitionRef.current) return;
    setVoiceError(null);
    if (isListening) {
      recognitionRef.current.stop();
    } else {
      try {
        recognitionRef.current.lang = voiceLang; // ensure lang is current
        recognitionRef.current.start();
        setIsListening(true);
      } catch (e) {
        // Safari can throw if start() is called while already started
        console.error('Could not start recognition:', e);
        setVoiceError('Could not start mic. Try tapping the button again.');
        setIsListening(false);
      }
    }
  };

  const cycleLang = () => {
    const langs = ['en-IN', 'hi-IN', 'mr-IN'];
    const labels = { 'en-IN': 'EN', 'hi-IN': 'HI', 'mr-IN': 'MR' };
    const next = langs[(langs.indexOf(voiceLang) + 1) % langs.length];
    setVoiceLang(next);
    return labels[next];
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setUploading(true);
    setUploadPhase('Preparing docket...');
    const formData = new FormData();
    formData.append('fileName', file.name);
    
    let generatedImages = [];

    try {
      if (file.type === 'application/pdf') {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        const scale = 1.5; 

        for (let i = 1; i <= pdf.numPages; i++) {
          setUploadPhase(`Digitizing page ${i} of ${pdf.numPages}...`);
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({ canvasContext: context, viewport }).promise;
          
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          generatedImages.push(dataUrl);
          
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
          formData.append('pages', blob, `page_${i}.jpg`);
        }
      } else {
        formData.append('pages', file);
        // Also create a local url to display
        const objUrl = URL.createObjectURL(file);
        generatedImages.push(objUrl);
      }

      setUploadPhase('Analyzing contents...');
      const response = await axios.post(`${API_URL}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setSelectedDoc(response.data);
      setPageImages(generatedImages); // Store images for Original view
      setChatHistory([]);
      setCenterTab('extracted');
      setRightTab('summary');
      fetchDocuments();
    } catch (error) {
      console.error('Upload failed', error);
      alert(error.response?.data?.error || 'Failed to upload document');
    } finally {
      setUploading(false);
    }
  };

  const handleDocSelect = (doc) => {
      setSelectedDoc(doc);
      // Reset views
      setCenterTab('extracted');
      setRightTab('summary');
      setChatHistory([]);
      setPageImages([]); // Note: since we don't save page images in backend, Original tab will be empty for previously uploaded docs.
  }

  const handleSendMessage = async (msgOverride = null) => {
    const msgToSend = msgOverride || chatMessage;
    if (!msgToSend.trim() || !selectedDoc) return;

    const newHistory = [...chatHistory, { type: 'user', text: msgToSend }];
    setChatHistory(newHistory);
    if (!msgOverride) setChatMessage('');
    setChatLoading(true);

    try {
      const response = await axios.post(`${API_URL}/chat`, {
        documentId: selectedDoc.id,
        question: msgToSend
      });
      setChatHistory([...newHistory, { 
        type: 'ai', 
        text: response.data.answer, 
        quote: response.data.supporting_quote,
        source: response.data.source || 'document'
      }]);
    } catch (error) {
      console.error('Chat failed', error);
      setChatHistory([...newHistory, { type: 'ai', text: 'Sorry, failed to get an answer.', quote: '' }]);
    } finally {
      setChatLoading(false);
    }
  };

  const getBNSWarning = (citations) => {
    if (!citations || citations.length === 0) return null;
    const mapped = citations.map(c => bnsMap.find(m => m.old === c.citation || c.citation.includes(m.old))).filter(Boolean);
    if (mapped.length === 0) return null;

    return (
      <div className="bg-clawde-oxblood/10 border-l-4 border-clawde-oxblood p-4 my-4 rounded shadow-sm">
        <h4 className="text-clawde-oxblood font-bold flex items-center gap-2 mb-1 uppercase tracking-wider text-sm font-sans">
          <AlertTriangle className="w-4 h-4" /> Law Update Notice
        </h4>
        <div className="text-sm text-clawde-ink mt-2 font-sans">
          {mapped.map((m, i) => (
            <p key={i} className="mb-1">This document cites <strong>{m.old}</strong> ({m.offence}). Since 1 July 2024, the corresponding provision is <strong>{m.new}</strong>.</p>
          ))}
          <p className="text-xs text-clawde-ink mt-2 border-t border-clawde-oxblood/20 pt-2 font-serif italic">Which law applies depends on the date of the offence, not the date of the document. Offences before 1 July 2024 are still tried under the IPC.</p>
        </div>
      </div>
    );
  };

  const highlightUncertainSpans = (text, spans) => {
    if (!text) return "";
    if (!spans || spans.length === 0) return text;
    let highlightedText = text;
    spans.forEach(span => {
        if(span && span.length > 3) {
            highlightedText = highlightedText.split(span).join(`<span class="bg-clawde-brass/30 border-b border-clawde-brass text-clawde-ink">${span}</span>`);
        }
    });
    return highlightedText;
  };

  return (
    <div className="min-h-screen font-sans flex flex-col md:flex-row bg-clawde-ink text-clawde-charcoal overflow-hidden">
      
      {/* 1. LEFT PANEL (Case Browser) - 3 Columns */}
      <div className="w-full md:w-3/12 lg:w-[22%] bg-clawde-ink border-r border-white/10 flex flex-col h-screen overflow-y-auto shrink-0 z-20">
        <div className="p-6 text-clawde-parchment">
            <h1 className="text-3xl font-bold font-serif flex items-center gap-2 tracking-tight">
                <FileText className="w-7 h-7 text-clawde-brass" /> Clawde
            </h1>
            <p className="text-xs text-clawde-parchment/60 mt-1 uppercase tracking-[0.2em] font-semibold">Justice Assistant</p>
        </div>

        <div className="p-5">
            <div className="relative">
                <input 
                type="file" 
                accept="image/*,application/pdf" 
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={uploading}
                />
                <button className={`w-full py-3 px-4 text-sm font-semibold transition-colors border ${uploading ? 'bg-clawde-ink border-white/20 text-white/50' : 'bg-clawde-parchment text-clawde-ink border-clawde-parchment hover:bg-white'}`}>
                {uploading ? uploadPhase : 'Upload New Document'}
                </button>
            </div>
        </div>

        <div className="flex-1 p-5 flex flex-col gap-3">
            <h3 className="text-[10px] font-bold text-clawde-parchment/50 uppercase tracking-widest mb-2 font-sans">Case Files</h3>
            {documents.length === 0 ? (
                <p className="text-sm text-clawde-parchment/60 font-serif italic">No documents uploaded. Add a scan to get started.</p>
            ) : (
                documents.map(doc => (
                <div 
                    key={doc.id} 
                    onClick={() => handleDocSelect(doc)}
                    className={`p-4 border cursor-pointer transition-all ${selectedDoc?.id === doc.id ? 'border-clawde-brass bg-clawde-ink shadow-sm' : 'border-white/10 hover:border-white/30 bg-clawde-ink/50'}`}
                >
                    <div className="flex justify-between items-start mb-1">
                        <span className="font-bold text-sm truncate pr-2 text-clawde-parchment font-sans">{doc.structuredData?.case_number || 'No Case Number'}</span>
                    </div>
                    <p className="text-[10px] text-clawde-brass uppercase tracking-wider font-semibold mb-1">{doc.structuredData?.doc_type || 'Legal Document'}</p>
                    <p className="text-xs text-clawde-parchment/40 truncate font-serif italic">{doc.fileName}</p>
                </div>
                ))
            )}
        </div>
        
        <div className="p-5 text-[10px] leading-relaxed text-clawde-parchment/40 border-t border-white/10 font-sans mt-auto">
            This tool provides information, not legal advice. Verify all details with a qualified advocate.
        </div>
      </div>

      {/* Main Content Split: Center & Right */}
      {!selectedDoc ? (
          <div className="flex-1 h-screen flex flex-col items-center justify-center bg-clawde-parchment text-clawde-ink/30 p-8 text-center">
              <FileText className="w-16 h-16 mb-4 opacity-50" />
              <p className="text-2xl font-serif">No document selected yet.</p>
              <p className="text-sm font-sans mt-2">Upload a scan to get started.</p>
          </div>
      ) : (
        <div className="flex-1 flex h-screen overflow-hidden">
            
            {/* 2. CENTER PANEL (Document Source) - 5 Columns */}
            <div className="w-[55%] bg-clawde-parchment flex flex-col h-full border-r border-clawde-ink/10">
                {/* Tab Strip Center */}
                <div className="flex bg-clawde-offwhite border-b border-clawde-ink/10 pt-2 px-4 gap-1">
                    <button 
                        onClick={() => setCenterTab('original')}
                        className={`px-6 py-3 text-sm font-semibold uppercase tracking-wider font-sans rounded-t ${centerTab === 'original' ? 'bg-clawde-parchment text-clawde-ink border-t-2 border-clawde-oxblood' : 'text-clawde-ink/60 hover:bg-clawde-parchment/50'}`}
                    >
                        Original
                    </button>
                    <button 
                        onClick={() => setCenterTab('extracted')}
                        className={`px-6 py-3 text-sm font-semibold uppercase tracking-wider font-sans rounded-t ${centerTab === 'extracted' ? 'bg-clawde-parchment text-clawde-ink border-t-2 border-clawde-oxblood' : 'text-clawde-ink/60 hover:bg-clawde-parchment/50'}`}
                    >
                        Extracted Text
                    </button>
                </div>
                
                {/* Center Content */}
                <div className="flex-1 overflow-y-auto p-8 relative">
                    {centerTab === 'original' && (
                        <div className="flex flex-col gap-4 items-center">
                            {pageImages.length > 0 ? (
                                pageImages.map((imgUrl, idx) => (
                                    <img key={idx} src={imgUrl} alt={`Page ${idx + 1}`} className="w-full max-w-2xl border border-clawde-ink/20 shadow-md" />
                                ))
                            ) : (
                                <p className="text-sm font-serif italic text-clawde-ink/50 text-center mt-20">Original image not available for this session. Please re-upload to view.</p>
                            )}
                        </div>
                    )}

                    {centerTab === 'extracted' && (
                        <div className="max-w-[75ch] mx-auto w-full">
                            {selectedDoc.structuredData?.uncertain_spans?.length > 0 && (
                                <div className="mb-6 flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-clawde-brass bg-clawde-brass/10 px-3 py-2 border-l-2 border-clawde-brass w-max">
                                    <AlertTriangle className="w-3 h-3" /> OCR Uncertainties Highlighted
                                </div>
                            )}
                            <div 
                                className="font-serif text-[15px] leading-[1.8] text-clawde-charcoal whitespace-pre-wrap text-justify"
                                dangerouslySetInnerHTML={{ __html: highlightUncertainSpans(selectedDoc.structuredData?.raw_text, selectedDoc.structuredData?.uncertain_spans) }}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* 3. RIGHT PANEL (Analytical Lens) - 4 Columns */}
            <div className="flex-1 bg-clawde-offwhite flex flex-col h-full">
                {/* Tab Strip Right */}
                <div className="flex bg-clawde-offwhite border-b border-clawde-ink/10 pt-2 px-2 overflow-x-auto no-scrollbar">
                    {['summary', 'details', 'timeline', 'ask'].map(tab => (
                        <button 
                            key={tab}
                            onClick={() => setRightTab(tab)}
                            className={`px-5 py-3 text-sm font-semibold uppercase tracking-wider font-sans rounded-t whitespace-nowrap ${rightTab === tab ? 'bg-clawde-offwhite text-clawde-ink border-b-2 border-clawde-oxblood relative top-[1px]' : 'text-clawde-ink/50 hover:text-clawde-ink border-b-2 border-transparent'}`}
                        >
                            {tab === 'ask' ? 'Ask (Chat)' : tab}
                        </button>
                    ))}
                </div>

                {/* Right Content */}
                <div className="flex-1 overflow-y-auto p-6 lg:p-8">
                    
                    {/* SUMMARY TAB */}
                    {rightTab === 'summary' && (
                        <div className="flex flex-col gap-8 h-full">
                            {selectedDoc.structuredData?.action_required && (
                                <div className="bg-clawde-oxblood text-white p-5 shadow-sm border-l-4 border-clawde-ink">
                                    <h3 className="text-xs font-bold uppercase tracking-widest opacity-80 mb-1 font-sans">Action Required</h3>
                                    <h2 className="text-lg font-bold font-serif leading-snug">
                                        {selectedDoc.structuredData.action_required}
                                    </h2>
                                </div>
                            )}
                            
                            <div className="flex flex-col gap-6">
                                <div className="bg-white p-6 border border-clawde-ink/10 relative">
                                    <div className="absolute top-0 left-0 w-1 h-full bg-clawde-ink"></div>
                                    <h3 className="font-bold text-clawde-ink/60 uppercase tracking-widest text-[10px] mb-4 font-sans">English Summary</h3>
                                    <ul className="list-disc pl-5 space-y-3 font-serif text-clawde-charcoal text-[15px] leading-relaxed">
                                        {selectedDoc.structuredData?.summary_en?.map((bullet, i) => (
                                            <li key={i} className="pl-1">{bullet}</li>
                                        ))}
                                    </ul>
                                </div>
                                
                                <div className="bg-white p-6 border border-clawde-ink/10 relative">
                                    <div className="absolute top-0 left-0 w-1 h-full bg-clawde-oxblood"></div>
                                    <h3 className="font-bold text-clawde-ink/60 uppercase tracking-widest text-[10px] mb-4 font-sans font-devanagari">इसका क्या मतलब है</h3>
                                    <ul className="list-disc pl-5 space-y-3 font-devanagari text-clawde-charcoal text-[17px] leading-relaxed">
                                        {selectedDoc.structuredData?.summary_hi?.map((bullet, i) => (
                                            <li key={i} className="pl-1">{bullet}</li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                            {getBNSWarning(selectedDoc.structuredData?.old_law_citations)}
                        </div>
                    )}

                    {/* DETAILS TAB */}
                    {rightTab === 'details' && (
                        <div className="flex flex-col gap-6">
                            <h2 className="text-2xl font-serif font-bold text-clawde-ink border-b border-clawde-ink/10 pb-4">Case Details</h2>
                            
                            <div className="grid grid-cols-1 gap-6">
                                <div>
                                    <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-1">Court Name</p>
                                    <p className="text-base font-serif font-bold text-clawde-charcoal">{selectedDoc.structuredData?.court_name || "Unknown Court"}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-1">Case Number</p>
                                    <p className="text-base font-serif text-clawde-charcoal">{selectedDoc.structuredData?.case_number || "N/A"}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-1">Document Type</p>
                                    <p className="text-base font-serif text-clawde-charcoal">{selectedDoc.structuredData?.doc_type || "N/A"}</p>
                                </div>
                                
                                {selectedDoc.structuredData?.parties && selectedDoc.structuredData.parties.length > 0 && (
                                    <div className="pt-4 border-t border-clawde-ink/10">
                                        <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-3">Parties Involved</p>
                                        <div className="flex flex-col gap-3">
                                            {selectedDoc.structuredData.parties.map((p, i) => (
                                                <div key={i} className="flex flex-col bg-white p-3 border border-clawde-ink/10">
                                                    <span className="font-bold font-serif text-clawde-charcoal">{p.name}</span>
                                                    <span className="text-xs font-sans text-clawde-ink/60 uppercase tracking-wider">{p.role}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* TIMELINE TAB */}
                    {rightTab === 'timeline' && (
                        <div className="flex flex-col gap-6 h-full">
                            <h2 className="text-2xl font-serif font-bold text-clawde-ink border-b border-clawde-ink/10 pb-4">Key Dates</h2>
                            
                            {!selectedDoc.structuredData?.key_dates || selectedDoc.structuredData.key_dates.length === 0 ? (
                                <p className="text-sm font-serif italic text-clawde-ink/50">No key dates extracted from this document.</p>
                            ) : (
                                <div className="flex flex-col relative pl-4 border-l border-clawde-ink/20 ml-2 mt-4 space-y-8">
                                    {selectedDoc.structuredData.key_dates.map((kd, idx) => (
                                        <div key={idx} className="relative pl-6">
                                            <div className="absolute w-3 h-3 bg-clawde-oxblood rounded-full -left-[6.5px] top-1 border-2 border-clawde-offwhite"></div>
                                            <div className="text-sm font-bold text-clawde-ink font-sans tracking-tight mb-1 flex items-center gap-2">
                                                <Calendar className="w-4 h-4 text-clawde-ink/40" /> {kd.date}
                                            </div>
                                            <div className="text-base text-clawde-charcoal font-serif">{kd.event}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ASK TAB */}
                    {rightTab === 'ask' && (
                        <div className="flex flex-col h-full max-h-full overflow-hidden">
                            <h2 className="text-2xl font-serif font-bold text-clawde-ink border-b border-clawde-ink/10 pb-4 mb-4 shrink-0">Consult Assistant</h2>
                            
                            <div className="flex-1 overflow-y-auto flex flex-col gap-4 text-sm pr-2 no-scrollbar pb-4">
                                {chatHistory.length === 0 && selectedDoc.structuredData?.suggested_questions && (
                                    <div className="flex flex-col gap-2 mt-auto">
                                        <p className="text-[10px] font-bold text-clawde-ink/50 uppercase tracking-widest font-sans mb-1">Suggested questions</p>
                                        {selectedDoc.structuredData.suggested_questions.map((q, i) => (
                                            <button key={i} onClick={() => handleSendMessage(q)} className="text-left bg-white border border-clawde-ink/20 hover:border-clawde-brass px-4 py-3 text-clawde-charcoal text-[13px] transition-colors w-full font-serif shadow-sm">
                                                {q}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {chatHistory.map((msg, idx) => (
                                    <div key={idx} className={`flex flex-col ${msg.type === 'user' ? 'items-end' : 'items-start'}`}>
                                        <div className={`max-w-[90%] px-5 py-3 text-[14px] leading-relaxed shadow-sm ${msg.type === 'user' ? 'bg-clawde-ink text-clawde-parchment font-sans' : 'bg-white border border-clawde-ink/10 text-clawde-charcoal font-serif'}`}>
                                            <p className={msg.text.match(/[\u0900-\u097F]/) ? 'font-devanagari text-base' : ''}>{msg.text}</p>
                                            {msg.quote && (
                                                <p className="text-[12px] mt-3 pt-3 border-t border-clawde-ink/10 italic text-clawde-ink/60 font-sans">"{msg.quote}"</p>
                                            )}
                                            {msg.type === 'ai' && (
                                                <div className="mt-2 pt-2 border-t border-clawde-ink/5 flex items-center gap-1">
                                                    {msg.source === 'general' ? (
                                                        <span className="text-[10px] font-sans font-semibold uppercase tracking-wider text-clawde-brass opacity-80">⚡ General guidance</span>
                                                    ) : (
                                                        <span className="text-[10px] font-sans font-semibold uppercase tracking-wider text-clawde-ink/30">📄 From document</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                {chatLoading && (
                                    <div className="text-xs text-clawde-ink/50 flex items-center gap-2 italic font-serif mt-2">
                                        <Loader2 className="w-3 h-3 animate-spin" /> Reviewing the file...
                                    </div>
                                )}
                            </div>
                            
                            <div className="pt-4 border-t border-clawde-ink/10 shrink-0">
                                {voiceError && (
                                    <p className="text-[11px] text-clawde-oxblood font-sans mb-2 flex items-center gap-1">
                                        <AlertTriangle className="w-3 h-3 shrink-0" /> {voiceError}
                                    </p>
                                )}
                                {!hasSpeechRecognition && (
                                    <p className="text-[11px] text-clawde-ink/40 font-sans mb-2">
                                        🎙 Voice input works best in Chrome. Safari has limited support.
                                    </p>
                                )}
                                <div className="flex gap-2">
                                    {hasSpeechRecognition && (
                                      <>
                                        <button 
                                            onClick={toggleListen}
                                            className={`p-3 transition-colors border ${isListening ? 'bg-clawde-oxblood text-white border-clawde-oxblood animate-pulse' : 'bg-white text-clawde-ink border-clawde-ink/20 hover:bg-clawde-parchment'}`}
                                            title={`Dictate (${voiceLang}) — click language badge to change`}
                                        >
                                            {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                                        </button>
                                        <button
                                            onClick={cycleLang}
                                            disabled={isListening}
                                            className="px-2 text-[10px] font-bold font-sans uppercase tracking-widest border border-clawde-ink/20 bg-white text-clawde-ink/50 hover:text-clawde-ink hover:border-clawde-ink/40 disabled:opacity-40 transition-colors"
                                            title="Cycle voice language: EN / HI / MR"
                                        >
                                            {voiceLang === 'en-IN' ? 'EN' : voiceLang === 'hi-IN' ? 'HI' : 'MR'}
                                        </button>
                                      </>
                                    )}
                                    <input 
                                        type="text"
                                        value={chatMessage}
                                        onChange={(e) => setChatMessage(e.target.value)}
                                        onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                                        placeholder="Ask in English, Hindi, or Marathi..."
                                        className="flex-1 bg-white border border-clawde-ink/20 px-4 py-2 text-sm focus:outline-none focus:border-clawde-brass font-sans placeholder-clawde-ink/30"
                                    />
                                    <button 
                                        onClick={() => handleSendMessage()}
                                        disabled={chatLoading || !chatMessage.trim()}
                                        className="bg-clawde-ink text-clawde-parchment px-6 py-2 text-sm font-semibold uppercase tracking-wider hover:bg-black disabled:opacity-50 transition-colors font-sans"
                                    >
                                        Send
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
      )}
    </div>
  );
}

export default App;
