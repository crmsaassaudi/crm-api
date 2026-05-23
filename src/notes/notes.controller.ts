import { Body, Controller, Delete, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../common/permissions';
import { CreateNoteDto } from './dto/create-note.dto';
import { NotesService } from './notes.service';

@ApiTags('Notes')
@ApiBearerAuth()
@Controller({
  path: 'notes',
  version: '1',
})
export class NotesController {
  constructor(private readonly service: NotesService) {}

  @Patch(':id')
  @RequirePermission('edit', 'contacts')
  update(@Param('id') _id: string, @Body() _data: CreateNoteDto) {
    void _id;
    void _data;
    // Versioned note editing is intentionally left out until product decides
    // whether notes require edit history.
    return { supported: false };
  }

  @Delete(':id')
  @RequirePermission('delete', 'contacts')
  remove(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
