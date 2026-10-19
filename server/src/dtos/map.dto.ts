import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PlacesResponseSchema } from 'src/dtos/search.dto.js';
import { isoDatetimeToDate, latitudeSchema, longitudeSchema, stringToBool } from 'src/validation.js';

const MapReverseGeocodeSchema = z
  .object({
    lat: z.coerce.number().meta({ format: 'double' }).pipe(latitudeSchema).describe('Latitude (-90 to 90)'),
    lon: z.coerce.number().meta({ format: 'double' }).pipe(longitudeSchema).describe('Longitude (-180 to 180)'),
  })
  .meta({ id: 'MapReverseGeocodeDto' });

const MapReverseGeocodeResponseSchema = z
  .object({
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State/Province name'),
    country: z.string().nullable().describe('Country name'),
  })
  .meta({ id: 'MapReverseGeocodeResponseDto' });

const MapMarkerSchema = z
  .object({
    isArchived: stringToBool.optional().describe('Filter by archived status'),
    isFavorite: stringToBool.optional().describe('Filter by favorite status'),
    fileCreatedAfter: isoDatetimeToDate.optional().describe('Filter assets created after this date'),
    fileCreatedBefore: isoDatetimeToDate.optional().describe('Filter assets created before this date'),
    withPartners: stringToBool.optional().describe('Include partner assets'),
    withSharedAlbums: stringToBool.optional().describe('Include shared album assets'),
  })
  .meta({ id: 'MapMarkerDto' });

const MapMarkerResponseSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    lat: z.number().meta({ format: 'double' }).describe('Latitude'),
    lon: z.number().meta({ format: 'double' }).describe('Longitude'),
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State/Province name'),
    country: z.string().nullable().describe('Country name'),
  })
  .meta({ id: 'MapMarkerResponseDto' });

export class MapReverseGeocodeDto extends createZodDto(MapReverseGeocodeSchema) {}
export class MapReverseGeocodeResponseDto extends createZodDto(MapReverseGeocodeResponseSchema) {}
export class MapMarkerDto extends createZodDto(MapMarkerSchema) {}
export class MapMarkerResponseDto extends createZodDto(MapMarkerResponseSchema) {}

export const ForkGeodataNameSchema = z
  .object({
    geonameId: z.int().positive(),
    kind: z.enum(['country', 'state', 'city']).meta({ id: 'ForkGeodataNameKind' }),
    scope: z.enum(['global', 'country', 'state', 'none']).meta({ id: 'ForkGeodataNameScope' }),
    name: z.string(),
    country: z.string(),
    state: z.string().nullable(),
    localizedName: z.string(),
    aliases: z.array(z.string()),
  })
  .meta({ id: 'ForkGeodataNameResponseDto' });

export class ForkGeodataNameResponseDto extends createZodDto(ForkGeodataNameSchema) {}

export class ForkPlaceResponseDto extends createZodDto(
  PlacesResponseSchema.extend({
    country: z.string().optional(),
    localizedName: z.string().optional(),
  }).meta({ id: 'ForkPlaceResponseDto' }),
) {}
