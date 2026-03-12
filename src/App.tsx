import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { Upload, Image as ImageIcon, Loader2, ShoppingCart, Search, AlertCircle, Sparkles } from 'lucide-react';

// Initialize Gemini API for text
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

interface Product {
  id: number;
  bounding_box: BoundingBox;
  brand: string;
  product_name: string;
  variant_or_flavor: string;
  perfect_search_query: string;
}

interface AnalysisResult {
  total_products_detected: number;
  products: Product[];
}

export default function App() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoveredProductId, setHoveredProductId] = useState<number | null>(null);
  
  const [crops, setCrops] = useState<Record<number, string>>({});
  const [packshots, setPackshots] = useState<Record<number, { loading: boolean, url?: string, error?: string }>>({});
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setSelectedImage(reader.result as string);
        setResult(null);
        setError(null);
        setCrops({});
        setPackshots({});
      };
      reader.readAsDataURL(file);
    }
  };

  const generateCrops = (imageSrc: string, products: Product[]) => {
    const img = new Image();
    img.onload = () => {
      const newCrops: Record<number, string> = {};
      products.forEach(p => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        const x = (p.bounding_box.xmin / 1000) * img.width;
        const y = (p.bounding_box.ymin / 1000) * img.height;
        const width = ((p.bounding_box.xmax - p.bounding_box.xmin) / 1000) * img.width;
        const height = ((p.bounding_box.ymax - p.bounding_box.ymin) / 1000) * img.height;
        
        const padding = Math.min(width, height) * 0.1;
        const cropX = Math.max(0, x - padding);
        const cropY = Math.max(0, y - padding);
        const cropW = Math.min(img.width - cropX, width + padding * 2);
        const cropH = Math.min(img.height - cropY, height + padding * 2);

        canvas.width = cropW;
        canvas.height = cropH;
        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        newCrops[p.id] = canvas.toDataURL('image/jpeg', 0.9);
      });
      setCrops(newCrops);
    };
    img.src = imageSrc;
  };

  const searchPackshot = async (product: Product) => {
    setPackshots(prev => ({ ...prev, [product.id]: { loading: true, error: undefined } }));
    try {
      const prompt = `Cerca su internet un'immagine ufficiale, packshot o su sfondo bianco per il prodotto: "${product.perfect_search_query}".
IMPORTANTE: Se non trovi l'immagine esatta, DEVI restituire l'URL dell'immagine del prodotto più simile o inerente che riesci a trovare.
Devi restituire un URL pubblico e diretto a un'immagine ad alta risoluzione (preferibilmente .jpg, .png o .webp).
Assicurati che l'URL sia accessibile. Restituisci SOLO un oggetto JSON con la chiave "url".`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              url: { type: Type.STRING, description: "URL diretto dell'immagine trovata su internet (esatta o simile)" }
            },
            required: ["url"]
          }
        }
      });

      if (response.text) {
        const parsed = JSON.parse(response.text);
        if (parsed.url && parsed.url.startsWith('http')) {
          setPackshots(prev => ({ ...prev, [product.id]: { loading: false, url: parsed.url } }));
          return;
        }
      }
      throw new Error("URL non trovato");
    } catch (err: any) {
      console.error(err);
      let errorMsg = "Immagine non trovata.";
      if (err.message?.includes("429") || err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED")) {
        errorMsg = "Limite richieste API superato. Riprova tra poco.";
      }
      setPackshots(prev => ({ ...prev, [product.id]: { loading: false, error: errorMsg } }));
    }
  };

  const analyzeImage = async () => {
    if (!selectedImage) return;

    setIsAnalyzing(true);
    setError(null);

    try {
      const mimeType = selectedImage.split(';')[0].split(':')[1];
      const base64Data = selectedImage.split(',')[1];

      const systemInstruction = `Agisci come "Pic-to-Purchase Vision Engine", un'intelligenza artificiale di altissima precisione specializzata nel riconoscimento visivo per e-commerce.

Il tuo compito è analizzare immagini di qualsiasi tipo (scaffali affollati, scrivanie, dispense, prodotti singoli) e identificare OGNI SINGOLO PRODOTTO presente nell'immagine, senza saltarne nessuno (nemmeno in immagini con 30+ oggetti).

Per ogni prodotto trovato, devi estrarre le informazioni visive e testuali e formulare una stringa di ricerca perfetta.

REGOLE FONDAMENTALI:

Zero Pigrizia: Devi scansionare l'immagine da in alto a sinistra a in basso a destra. Non fermarti dopo 5 o 10 prodotti. Se ce ne sono 25, voglio 25 risultati.

Bounding Boxes: Per ogni prodotto, devi fornire le coordinate del riquadro di delimitazione (bounding box) nel formato [ymin, xmin, ymax, xmax] normalizzato da 0 a 1000.

Perfect Search Query: Usa la tua conoscenza per generare una "perfect_search_query". Questa stringa sarà usata su Google Shopping API. Deve contenere: Marca + Nome Prodotto + Variante/Gusto + Formato (se deducibile) + la parola chiave "packshot" o "white background" per favorire risultati con immagini pulite adatte a un sito web.

Output SOLO JSON: Non aggiungere convenevoli, saluti o testo in markdown fuori dal JSON. Devi restituire unicamente un oggetto JSON valido con la struttura richiesta.`;

      const prompt = `Analizza l'immagine allegata ed estrai i dati di tutti i prodotti presenti.
Restituisci il risultato ESATTAMENTE in questa struttura JSON:

{
  "total_products_detected": 0,
  "products": [
    {
      "id": 1,
      "bounding_box": {
        "ymin": 0,
        "xmin": 0,
        "ymax": 0,
        "xmax": 0
      },
      "brand": "Nome della marca (es. Diana, San Carlo)",
      "product_name": "Nome specifico (es. Jalapeños, Goleador)",
      "variant_or_flavor": "Gusto, colore o caratteristica (es. Piccante, Cola)",
      "perfect_search_query": "Es: Diana Jalapeños snacks 100g packshot white background"
    }
  ]
}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: mimeType,
                },
              },
              { text: prompt }
            ],
          }
        ],
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              total_products_detected: { type: Type.INTEGER },
              products: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.INTEGER },
                    bounding_box: {
                      type: Type.OBJECT,
                      properties: {
                        ymin: { type: Type.INTEGER },
                        xmin: { type: Type.INTEGER },
                        ymax: { type: Type.INTEGER },
                        xmax: { type: Type.INTEGER }
                      },
                      required: ["ymin", "xmin", "ymax", "xmax"]
                    },
                    brand: { type: Type.STRING },
                    product_name: { type: Type.STRING },
                    variant_or_flavor: { type: Type.STRING },
                    perfect_search_query: { type: Type.STRING }
                  },
                  required: ["id", "bounding_box", "brand", "product_name", "variant_or_flavor", "perfect_search_query"]
                }
              }
            },
            required: ["total_products_detected", "products"]
          }
        }
      });

      if (response.text) {
        const parsedResult = JSON.parse(response.text) as AnalysisResult;
        setResult(parsedResult);
        generateCrops(selectedImage, parsedResult.products);
      } else {
        setError("Nessun risultato restituito dall'API.");
      }
    } catch (err: any) {
      console.error("Error analyzing image:", err);
      let errorMsg = err.message || "Si è verificato un errore durante l'analisi dell'immagine.";
      if (errorMsg.includes("429") || errorMsg.includes("quota") || errorMsg.includes("RESOURCE_EXHAUSTED")) {
        errorMsg = "Limite di richieste superato (Quota Exceeded). Attendi qualche istante e riprova.";
      }
      setError(errorMsg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Draw bounding boxes on canvas
  useEffect(() => {
    if (!selectedImage || !result || !canvasRef.current || !imageRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const image = imageRef.current;

    if (!ctx) return;

    canvas.width = image.width;
    canvas.height = image.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    result.products.forEach((product) => {
      const { ymin, xmin, ymax, xmax } = product.bounding_box;
      
      const x = (xmin / 1000) * canvas.width;
      const y = (ymin / 1000) * canvas.height;
      const width = ((xmax - xmin) / 1000) * canvas.width;
      const height = ((ymax - ymin) / 1000) * canvas.height;

      const isHovered = hoveredProductId === product.id;

      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.lineWidth = isHovered ? 4 : 2;
      ctx.strokeStyle = isHovered ? '#10b981' : '#3b82f6';
      ctx.fillStyle = isHovered ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.1)';
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isHovered ? '#10b981' : '#3b82f6';
      ctx.fillRect(x, y - 24, 30, 24);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px Inter, sans-serif';
      ctx.fillText(`#${product.id}`, x + 6, y - 7);
    });
  }, [result, selectedImage, hoveredProductId]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-blue-600 p-2 rounded-lg text-white">
              <ShoppingCart size={20} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Pic-to-Purchase Vision Engine</h1>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column: Upload & Image View */}
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <ImageIcon size={20} className="text-slate-500" />
                Carica Immagine
              </h2>
              
              {!selectedImage ? (
                <label className="flex flex-col items-center justify-center w-full h-64 border-2 border-slate-300 border-dashed rounded-xl cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className="w-10 h-10 text-slate-400 mb-3" />
                    <p className="mb-2 text-sm text-slate-500">
                      <span className="font-semibold">Clicca per caricare</span> o trascina un'immagine
                    </p>
                    <p className="text-xs text-slate-400">PNG, JPG o WEBP</p>
                  </div>
                  <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                </label>
              ) : (
                <div className="space-y-4">
                  <div className="relative rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
                    <img 
                      ref={imageRef}
                      src={selectedImage} 
                      alt="Uploaded" 
                      className="w-full h-auto object-contain max-h-[600px]"
                      onLoad={() => {
                        if (result) setResult({...result});
                      }}
                    />
                    {result && (
                      <canvas 
                        ref={canvasRef}
                        className="absolute top-0 left-0 w-full h-full pointer-events-none"
                      />
                    )}
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setSelectedImage(null);
                        setResult(null);
                        setCrops({});
                        setPackshots({});
                      }}
                      className="flex-1 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 font-medium transition-colors"
                    >
                      Cambia Immagine
                    </button>
                    <button
                      onClick={analyzeImage}
                      disabled={isAnalyzing}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors disabled:opacity-70 flex items-center justify-center gap-2"
                    >
                      {isAnalyzing ? (
                        <>
                          <Loader2 size={18} className="animate-spin" />
                          Analisi in corso...
                        </>
                      ) : (
                        <>
                          <Search size={18} />
                          Analizza Prodotti
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-lg flex items-start gap-3 border border-red-100">
                  <AlertCircle size={20} className="shrink-0 mt-0.5" />
                  <p className="text-sm">{error}</p>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Results */}
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 min-h-[400px]">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <ShoppingCart size={20} className="text-slate-500" />
                  Prodotti Rilevati
                </h2>
                <div className="flex items-center gap-3">
                  {result && (
                    <span className="bg-blue-100 text-blue-800 text-xs font-semibold px-2.5 py-1 rounded-full">
                      {result.total_products_detected} trovati
                    </span>
                  )}
                </div>
              </div>

              {!result && !isAnalyzing && (
                <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-center">
                  <ShoppingCart size={48} className="mb-4 opacity-20" />
                  <p>Carica un'immagine e avvia l'analisi<br/>per vedere i prodotti qui.</p>
                </div>
              )}

              {isAnalyzing && (
                <div className="h-64 flex flex-col items-center justify-center text-slate-500">
                  <Loader2 size={40} className="animate-spin mb-4 text-blue-600" />
                  <p className="font-medium">Scansione scaffali in corso...</p>
                  <p className="text-sm text-slate-400 mt-2">Identificazione brand e varianti</p>
                </div>
              )}

              {result && result.products.length > 0 && (
                <div className="space-y-4 max-h-[800px] overflow-y-auto pr-2 custom-scrollbar">
                  {result.products.map((product) => (
                    <div 
                      key={product.id}
                      className="p-4 rounded-xl border border-slate-200 hover:border-blue-400 hover:shadow-md transition-all bg-white cursor-pointer group"
                      onMouseEnter={() => setHoveredProductId(product.id)}
                      onMouseLeave={() => setHoveredProductId(null)}
                    >
                      <div className="flex flex-col sm:flex-row gap-4">
                        
                        {/* Original Crop */}
                        <div className="shrink-0 flex flex-col items-center gap-2">
                          <div className="w-24 h-24 rounded-lg border border-slate-200 overflow-hidden bg-slate-50 flex items-center justify-center">
                            {crops[product.id] ? (
                              <img src={crops[product.id]} alt="Crop" className="w-full h-full object-cover" />
                            ) : (
                              <ImageIcon className="text-slate-300" />
                            )}
                          </div>
                          <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Originale</span>
                        </div>

                        {/* Details */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 mb-1">
                            <div className="bg-slate-100 text-slate-600 font-bold w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0 group-hover:bg-blue-100 group-hover:text-blue-700 transition-colors">
                              {product.id}
                            </div>
                            <h3 className="font-bold text-slate-900 truncate text-lg">
                              {product.brand} {product.product_name}
                            </h3>
                          </div>
                          <p className="text-sm text-slate-600 mb-3">
                            <span className="font-medium text-slate-700">Variante:</span> {product.variant_or_flavor}
                          </p>
                          <div className="bg-slate-50 p-2 rounded-lg border border-slate-100 mb-2">
                            <p className="text-[10px] font-mono text-slate-500 mb-1 uppercase tracking-wider">Query di Ricerca</p>
                            <p className="text-xs font-medium text-slate-800 break-words">
                              {product.perfect_search_query}
                            </p>
                          </div>
                        </div>

                        {/* Web Search Result */}
                        <div className="shrink-0 flex flex-col items-center gap-2 border-l border-slate-100 pl-4">
                          <div className="w-24 h-24 rounded-lg border border-slate-200 overflow-hidden bg-slate-50 flex items-center justify-center relative group/img">
                            {packshots[product.id]?.loading ? (
                              <Loader2 className="animate-spin text-blue-500" />
                            ) : packshots[product.id]?.url ? (
                              <a href={packshots[product.id].url} target="_blank" rel="noopener noreferrer" className="w-full h-full block">
                                <img 
                                  src={packshots[product.id].url} 
                                  alt="Packshot" 
                                  className="w-full h-full object-contain bg-white" 
                                  referrerPolicy="no-referrer"
                                  onError={() => {
                                    setPackshots(prev => ({ ...prev, [product.id]: { loading: false, error: "Immagine protetta dal sito." } }));
                                  }}
                                />
                              </a>
                            ) : (
                              <button 
                                onClick={(e) => { e.stopPropagation(); searchPackshot(product); }}
                                className="w-full h-full flex flex-col items-center justify-center text-blue-600 hover:bg-blue-50 transition-colors gap-1"
                              >
                                <Search size={20} />
                                <span className="text-[10px] font-bold text-center px-1 leading-tight">Cerca<br/>Web</span>
                              </button>
                            )}
                          </div>
                          <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">E-commerce</span>
                          {packshots[product.id]?.error && (
                            <div className="flex flex-col items-center gap-1 mt-1">
                              <span className="text-[9px] text-red-500 text-center max-w-[96px] leading-tight">
                                {packshots[product.id].error}
                              </span>
                              <a 
                                href={`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(product.perfect_search_query)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[9px] bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded"
                                onClick={(e) => e.stopPropagation()}
                              >
                                Apri Google
                              </a>
                            </div>
                          )}
                        </div>

                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
