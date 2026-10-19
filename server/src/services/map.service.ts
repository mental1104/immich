import { Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { MapMarkerDto, MapMarkerResponseDto, MapReverseGeocodeDto } from 'src/dtos/map.dto.js';
import { SearchPlacesDto, mapPlaces } from 'src/dtos/search.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';

@Injectable()
export class MapService extends BaseService {
  getForkLocalizedNames() {
    return this.mapRepository.getLocalizedNames();
  }

  async getForkSearchPlaces({ name }: SearchPlacesDto) {
    const [localized, original] = await Promise.all([
      this.mapRepository.searchLocalizedPlaces(name),
      this.searchRepository.searchPlaces(name),
    ]);
    const seen = new Set<number>();
    const places = [
      ...localized.map((place) => ({
        id: place.id,
        value: {
          ...mapPlaces(place),
          localizedName: place.localizedName,
          country: place.country,
        },
      })),
      ...original.map((place) => ({ id: place.id, value: mapPlaces(place) })),
    ];
    return places
      .filter((place) => {
        if (seen.has(place.id)) {
          return false;
        }
        seen.add(place.id);
        return true;
      })
      .slice(0, 20)
      .map((place) => place.value);
  }

  async getMapMarkers(auth: AuthDto, options: MapMarkerDto): Promise<MapMarkerResponseDto[]> {
    const userIds = [auth.user.id];
    if (options.withPartners) {
      const partnerIds = await getMyPartnerIds({ userId: auth.user.id, repository: this.partnerRepository });
      userIds.push(...partnerIds);
    }

    const albumIds = options.withSharedAlbums ? await this.albumRepository.getAllIds(auth.user.id) : [];

    return this.mapRepository.getMapMarkers(auth.user.id, userIds, albumIds, options);
  }

  async reverseGeocode(dto: MapReverseGeocodeDto) {
    const { lat: latitude, lon: longitude } = dto;
    // eventually this should probably return an array of results
    const result = await this.mapRepository.reverseGeocode({ latitude, longitude });
    return result ? [result] : [];
  }
}
