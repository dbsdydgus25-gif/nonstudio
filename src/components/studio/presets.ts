export interface ModelPreset {
  id: string;
  name: string;
  url: string;
}

export const MY_FITTING_MODELS: ModelPreset[] = [
  { id: '1', name: '피팅 모델 #1', url: '/models/1.png' },
  { id: '2', name: '피팅 모델 #2', url: '/models/2.png' },
  { id: '3', name: '피팅 모델 #3', url: '/models/3.png' },
  { id: '4', name: '피팅 모델 #4', url: '/models/4.png' },
  { id: '5', name: '피팅 모델 #5', url: '/models/5.webp' },
  { id: '6', name: '피팅 모델 #6', url: '/models/6.webp' },
  { id: '7', name: '피팅 모델 #7', url: '/models/7.png' },
  { id: '8', name: '피팅 모델 #8', url: '/models/8.jpg' },
];

export const SAMPLE_GARMENT_IMAGE = 'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=800&q=90';
