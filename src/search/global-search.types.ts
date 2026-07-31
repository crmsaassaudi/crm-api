import { SearchModule } from './dto/global-search-query.dto';
import { SearchHighlightRange } from './search-ranking';

export interface GlobalSearchResult {
  id: string;
  module: SearchModule;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
  highlights: {
    title?: SearchHighlightRange[];
    subtitle?: SearchHighlightRange[];
  };
}
