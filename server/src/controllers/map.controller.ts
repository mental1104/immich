import { Controller, Get, Header, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ForkGeodataNameResponseDto,
  ForkPlaceResponseDto,
  MapMarkerDto,
  MapMarkerResponseDto,
  MapReverseGeocodeDto,
  MapReverseGeocodeResponseDto,
} from 'src/dtos/map.dto.js';
import { SearchPlacesDto } from 'src/dtos/search.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MapService } from 'src/services/map.service.js';

@ApiTags(ApiTag.Map)
@Controller('map')
export class MapController {
  constructor(private service: MapService) {}

  @Get('fork/localized-names')
  @Authenticated({ permission: Permission.MapSearch })
  @Header('Cache-Control', 'private, no-cache')
  @Endpoint({
    summary: 'Retrieve offline Chinese place names and search aliases',
    history: new HistoryBuilder().added('v3.3.3'),
  })
  getForkLocalizedNames(): Promise<ForkGeodataNameResponseDto[]> {
    return this.service.getForkLocalizedNames();
  }

  @Get('fork/search-places')
  @Authenticated({ permission: Permission.MapSearch })
  @Endpoint({ summary: 'Search places using offline Chinese aliases', history: new HistoryBuilder().added('v3.3.3') })
  getForkSearchPlaces(@Query() dto: SearchPlacesDto): Promise<ForkPlaceResponseDto[]> {
    return this.service.getForkSearchPlaces(dto);
  }

  @Get('markers')
  @Authenticated({ permission: Permission.MapRead })
  @Endpoint({
    summary: 'Retrieve map markers',
    description: 'Retrieve a list of latitude and longitude coordinates for every asset with location data.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getMapMarkers(@Auth() auth: AuthDto, @Query() options: MapMarkerDto): Promise<MapMarkerResponseDto[]> {
    return this.service.getMapMarkers(auth, options);
  }

  @Get('reverse-geocode')
  @Authenticated({ permission: Permission.MapSearch })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Reverse geocode coordinates',
    description: 'Retrieve location information (e.g., city, country) for given latitude and longitude coordinates.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  reverseGeocode(@Query() dto: MapReverseGeocodeDto): Promise<MapReverseGeocodeResponseDto[]> {
    return this.service.reverseGeocode(dto);
  }
}
